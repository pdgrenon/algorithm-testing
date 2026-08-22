/**
 * Bootstrap, routing, and the wiring between the store, the engine and the views.
 *
 * Small on purpose — the views draw and the engine decides; this only decides
 * what to hand them and what a tap means.
 *
 * The render path is cache-first and never blocks. The week is drawn from
 * whatever this device last saw, the network answer replaces it in place, and
 * the season schedule — which is what makes the lookahead real — arrives later
 * still and triggers a third pass. At no point is there a spinner over the one
 * screen that matters.
 */

import * as store from './store/index.js';
import { makeContext, run, compareAll, agreementOf, getStrategy, listStrategies, resolveParams, DEFAULT_STRATEGY_ID } from './engine/index.js';
import { loadWeek, loadSeason, scheduleGames } from './data/source.js';
import { ABBRS } from './data/teams.js';
import { esc, paint, onAction, captureFocus, restoreFocus } from './ui/dom.js';
import { icon, mark } from './ui/icons.js';
import { toast, haptic, confirmDestructive } from './ui/fx.js';
import * as weekView from './views/week.js';
import * as boardView from './views/board.js';
import * as seasonView from './views/season.js';
import * as settingsView from './views/settings.js';

const ROUTES = {
  '#/week': { view: weekView, label: 'Week', icon: 'week' },
  '#/board': { view: boardView, label: 'Board', icon: 'board' },
  '#/season': { view: seasonView, label: 'Season', icon: 'season' },
  '#/settings': { view: settingsView, label: 'Settings', icon: 'settings' },
};

const root = document.getElementById('view');
const nav = document.getElementById('nav');
const masthead = document.getElementById('masthead');

/** Everything fetched, kept out of the store because none of it is ours. */
const live = { week: null, season: null, activeEntry: null };

let alarm = null;
store.storage.onAlarm((a) => { alarm = a; render(); });

/* ---------------------------------------------------------------- theme -- */

function applyTheme() {
  const { theme } = store.getState();
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/* --------------------------------------------------------------- routing -- */

const route = () => (ROUTES[location.hash] ? location.hash : '#/week');

function renderNav() {
  const current = route();
  nav.innerHTML = `<div class="nav__inner">${Object.entries(ROUTES).map(([href, r]) => `
    <a class="nav__btn" href="${href}" ${href === current ? 'aria-current="page"' : ''}>
      ${icon(r.icon, 21)}<span>${r.label}</span>
    </a>`).join('')}</div>`;
}

function renderMasthead() {
  masthead.innerHTML = `
    <span class="masthead__mark">${mark(26)}</span>
    <span class="masthead__name">Deadpool</span>
    <span class="masthead__season">${esc(store.getSeason())}</span>`;
}

/* ---------------------------------------------------------------- models -- */

function engineContext() {
  const games = live.week?.games ?? [];
  const season = live.week?.season ?? store.getSeason();
  const week = live.week?.week ?? null;
  return makeContext({
    season,
    week,
    games,
    scheduleGames: scheduleGames(live.season),
    entries: store.getEntries(),
    usedTeams: store.usedTeamsByEntry(season),
    fetchedAt: live.week?.fetchedAt ?? null,
    source: live.week?.source ?? 'none',
  });
}

function weekModel() {
  const entries = store.getEntries();
  const season = live.week?.season ?? store.getSeason();
  const week = live.week?.week ?? null;
  const strategyId = store.getState().strategyId ?? DEFAULT_STRATEGY_ID;

  const ctx = engineContext();
  const result = week ? run(strategyId, ctx, store.paramsFor(strategyId)) : null;

  const picksThisWeek = Object.fromEntries(
    entries.map((e) => [e.id, week ? store.pickAtWeek(e.id, week, season) : null]),
  );

  // One entry already committed, the other not: the strategies take a
  // used-teams list and nothing else, so they cannot know about it. Rather
  // than quietly changing what they are given, say it out loud — the whole
  // point of a pair strategy is that one result must not take both entries.
  const warnings = [...(result?.warnings ?? [])];
  for (const a of entries) {
    for (const b of entries) {
      if (a.id >= b.id) continue;
      const made = picksThisWeek[a.id] ?? picksThisWeek[b.id];
      const other = picksThisWeek[a.id] ? b : a;
      const suggestion = (result?.picks ?? []).find((p) => p.entry === other.id)?.candidate;
      if (made && !picksThisWeek[other.id] && suggestion && made.eventId && suggestion.eventId === made.eventId) {
        warnings.push({
          level: 'danger',
          text: `${other.name}'s recommendation is in the same game as the pick already recorded for the other entry. One result would eliminate both.`,
        });
      }
    }
  }

  return {
    payload: live.week,
    result: result ? { ...result, warnings } : null,
    entries,
    season,
    week,
    strategy: getStrategy(strategyId),
    statuses: Object.fromEntries(entries.map((e) => [e.id, store.statusFor(e.id, season)])),
    headline: store.headlineOf(week, season),
    picksThisWeek,
    alarm,
  };
}

function boardModel() {
  const entries = store.getEntries();
  const season = live.week?.season ?? store.getSeason();
  const games = live.week?.games ?? [];
  if (!live.activeEntry) live.activeEntry = entries[0]?.id ?? 'A';
  return {
    entries,
    activeEntry: live.activeEntry,
    season,
    week: live.week?.week ?? '—',
    boards: Object.fromEntries(entries.map((e) => [e.id, store.boardOf(e.id, games, ABBRS, season)])),
    statuses: Object.fromEntries(entries.map((e) => [e.id, store.statusFor(e.id, season)])),
  };
}

function seasonModel() {
  const entries = store.getEntries();
  const season = live.week?.season ?? store.getSeason();
  return {
    entries,
    season,
    timeline: store.timelineFor(season),
    statuses: Object.fromEntries(entries.map((e) => [e.id, store.statusFor(e.id, season)])),
  };
}

function settingsModel() {
  const state = store.getState();
  const strategyId = state.strategyId ?? DEFAULT_STRATEGY_ID;
  const active = getStrategy(strategyId) ?? listStrategies()[0];
  const ctx = live.week?.week ? engineContext() : null;

  return {
    state,
    strategies: listStrategies(),
    activeStrategy: active,
    params: resolveParams(active, store.paramsFor(active.id)),
    comparison: ctx ? buildComparison(ctx) : null,
    storage: { total: store.totalBytes(), cache: store.cacheBytes() },
    alarm,
  };
}

function buildComparison(ctx) {
  const stored = Object.fromEntries(listStrategies().map((s) => [s.id, store.paramsFor(s.id)]));
  const results = compareAll(ctx, stored);
  return { results, agreement: agreementOf(results) };
}

/* ---------------------------------------------------------------- render -- */

function render() {
  const anchor = captureFocus(root);
  const hash = route();
  const { view } = ROUTES[hash];

  const model = hash === '#/week' ? weekModel()
    : hash === '#/board' ? boardModel()
      : hash === '#/season' ? seasonModel()
        : settingsModel();

  view.render(root, model);
  paint(root);          // CSSOM pass — see ui/dom.js for why this is not inline style
  renderNav();
  restoreFocus(root, anchor);
}

/* --------------------------------------------------------------- actions -- */

function takePick(entryId, team) {
  const week = live.week?.week;
  const season = live.week?.season ?? store.getSeason();
  if (!week) return;

  const ctx = engineContext();
  const option = (ctx.games ?? []).flatMap((g) => [
    { g, side: g.home, opp: g.away }, { g, side: g.away, opp: g.home },
  ]).find((x) => x.side.abbreviation === team);
  if (!option) return;

  const strategyId = store.getState().strategyId;
  const result = run(strategyId, ctx, store.paramsFor(strategyId));
  const suggested = (result.picks ?? []).find((p) => p.entry === entryId)?.candidate ?? null;
  const snapshot = suggested && suggested.teamAbbreviation === team
    ? { winPct: suggested.winPct, source: suggested.winPctSource, spread: suggested.spreadDetail }
    : null;

  const { ok, previous } = store.recordPick({
    entry: entryId, season, week, team,
    opponent: option.opp.abbreviation,
    eventId: option.g.eventId,
    startDate: option.g.startDate,
    strategyId,
    snapshot,
    source: suggested && suggested.teamAbbreviation === team ? 'app' : 'manual',
  });

  if (!ok) return;                       // the alarm has already been raised
  haptic();
  render();
  toast(`${team} recorded for ${entryName(entryId)}`, {
    undo: () => {
      if (previous) store.restorePick(previous); else store.removePick(store.pickId(season, week, entryId));
      render();
    },
  });
}

const entryName = (id) => store.getEntries().find((e) => e.id === id)?.name ?? id;

function setResult(id, result) {
  const { ok, previous } = store.setResult(id, result);
  if (!ok) return;
  haptic();
  render();
  toast(`Recorded as ${result}`, { undo: () => { store.setResult(id, previous.result); render(); } });
}

/** Tap a season cell to step through the outcomes, rather than open a menu. */
function cycleResult(id) {
  const order = ['pending', 'win', 'loss', 'tie'];
  const pick = store.getPicks().find((p) => p.id === id);
  if (!pick) return;
  setResult(id, order[(order.indexOf(pick.result) + 1) % order.length]);
}

function unpick(id) {
  const { ok, previous } = store.removePick(id);
  if (!ok) return;
  render();
  toast('Pick cleared', { undo: () => { store.restorePick(previous); render(); } });
}

function exportBackup() {
  const body = JSON.stringify(store.exportAll(), null, 2);
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `deadpool-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Backup downloaded');
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let payload;
    try { payload = JSON.parse(String(reader.result)); } catch { toast('That file is not JSON'); return; }
    const mode = confirmDestructive('Replace everything on this device with the backup?\n\nCancel to merge instead, which keeps what is here and only adds weeks that are missing.')
      ? 'replace' : 'merge';
    const r = store.importAll(payload, { mode });
    toast(r.ok ? `Imported (${mode})` : r.reason);
    render();
  };
  reader.readAsText(file);
}

const ACTIONS = {
  take: ({ entry, team }) => takePick(entry, team),
  result: ({ id, result }) => setResult(id, result),
  cycle: ({ id }) => cycleResult(id),
  unpick: ({ id }) => unpick(id),
  entry: ({ entry }) => { live.activeEntry = entry; render(); },
  strategy: ({ id }) => { store.setStrategy(id); render(); },
  refresh: () => refresh(),
  export: () => exportBackup(),
  import: () => root.querySelector('[data-bind="importFile"]')?.click(),
  'clear-cache': () => { const n = store.clearCache(); toast(`Cleared ${n} cached item${n === 1 ? '' : 's'}`); render(); },
  erase: () => {
    if (!confirmDestructive('Erase every pick and setting on this device?\n\nThis cannot be undone. Export a backup first if you want one.')) return;
    store.eraseAll();
    toast('Everything erased');
    render();
  },
};

/** Inputs are bound rather than delegated, because they fire on change. */
root.addEventListener('change', (event) => {
  const el = event.target.closest('[data-bind]');
  if (!el) return;
  const bind = el.dataset.bind;

  if (bind === 'entryName') {
    const entries = store.getEntries().map((e) => (e.id === el.dataset.entry ? { ...e, name: el.value.trim() || `Entry ${e.id}` } : e));
    store.setSettings({ entries });
  } else if (bind === 'strikes') {
    store.setSettings({ strikesAllowed: Number(el.value) });
  } else if (bind === 'tieIsLoss') {
    store.setSettings({ tieIsLoss: el.checked });
  } else if (bind === 'theme') {
    store.setSettings({ theme: el.value });
    applyTheme();
  } else if (bind === 'param') {
    const id = store.getState().strategyId;
    const strategy = getStrategy(id);
    const next = { ...store.paramsFor(id), [el.dataset.key]: el.type === 'checkbox' ? el.checked : el.value };
    store.setStrategy(id, resolveParams(strategy, next));
  } else if (bind === 'importFile') {
    if (el.files && el.files[0]) importBackup(el.files[0]);
    return;                                 // the reader re-renders when it lands
  }
  render();
});

// A range should move its readout as it is dragged, not when it is released.
root.addEventListener('input', (event) => {
  const el = event.target.closest('input[type="range"]');
  if (!el) return;
  const readout = el.parentElement?.querySelector('.field__value');
  if (readout) readout.textContent = el.dataset.key && el.id.startsWith('param-') && el.step !== '1' ? el.value : el.value;
});

onAction(root, ACTIONS);

/* ----------------------------------------------------------------- data -- */

async function refresh() {
  await loadWeek({}, (payload) => { live.week = payload; render(); });
  const season = await loadSeason(live.week?.season ?? store.getSeason());
  if (season) { live.season = season; render(); }
}

/* ------------------------------------------------------------ lifecycle -- */

window.addEventListener('hashchange', render);

/**
 * A day boundary, a returning tab, and a kickoff all change what this screen
 * should say. Re-rendering on visibility covers the first two; the minute
 * timer is for the third, because a countdown that only updates when you touch
 * it is worse than no countdown.
 */
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); refresh(); } });
setInterval(() => { if (!document.hidden && route() === '#/week') render(); }, 60_000);

store.subscribe(() => { /* views re-render explicitly; this keeps the hook honest */ });

store.load();
applyTheme();
renderMasthead();
render();
refresh();

/* ---------------------------------------------------------------- worker -- */

/**
 * The update prompt.
 *
 * The worker never calls skipWaiting on its own — see sw.js. The page decides
 * when to swap, so an update cannot change the app out from under somebody
 * mid-pick, which on a Sunday at 12:55 is exactly when an update would land.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(next);
        });
      });
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    } catch { /* the app works without it, just not offline */ }
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

function offerUpdate(worker) {
  if (document.querySelector('.update')) return;
  const bar = document.createElement('div');
  bar.className = 'update';
  bar.innerHTML = `<span>A new version is ready.</span>`;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--primary btn--sm';
  button.textContent = 'Reload';
  button.addEventListener('click', () => worker.postMessage({ type: 'SKIP_WAITING' }));
  bar.appendChild(button);
  document.body.appendChild(bar);
}
