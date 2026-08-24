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
import { loadWeek, loadSeason, loadPool, scheduleGames, describePool } from './data/source.js';
import { makeField, EMPTY_FIELD } from './engine/field.js';
import { planReminders, toIcs, icsFilename } from './engine/calendar.js';
import { ABBRS } from './data/teams.js';
import { esc, paint, onAction, captureFocus, restoreFocus } from './ui/dom.js';
import { icon, mark } from './ui/icons.js';
import { toast, haptic, confirmDestructive } from './ui/fx.js';
import * as weekView from './views/week.js';
import * as boardView from './views/board.js';
import * as seasonView from './views/season.js';
import * as poolView from './views/pool.js';
import * as settingsView from './views/settings.js';

const ROUTES = {
  '#/week': { view: weekView, label: 'Week', icon: 'week' },
  '#/board': { view: boardView, label: 'Board', icon: 'board' },
  '#/season': { view: seasonView, label: 'Season', icon: 'season' },
  '#/pool': { view: poolView, label: 'Pool', icon: 'pool' },
  '#/settings': { view: settingsView, label: 'Settings', icon: 'settings' },
};

const root = document.getElementById('view');
const nav = document.getElementById('nav');
const masthead = document.getElementById('masthead');

/** Everything fetched, kept out of the store because none of it is ours. */
const live = {
  week: null, season: null, pool: null, activeEntry: null,
  // Whether the Week screen's strategy comparison is open.
  //
  // It is not computed unless it is, and that is the point. `compareAll` runs
  // every registered strategy -- 284 ms even after the beam-width fix, against
  // a Week screen that renders in about 100 -- so building it on every render
  // would have handed back most of what that fix bought, to draw a table
  // nobody had asked to see.
  compare: false,
};

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
    // The field, if a sheet is configured and answered. `EMPTY_FIELD` is the
    // ordinary case rather than the exception, and a strategy that ignores it
    // — which is every strategy today — behaves identically either way.
    field: live.pool ? makeField(live.pool) : EMPTY_FIELD,
    fetchedAt: live.week?.fetchedAt ?? null,
    source: live.week?.source ?? 'none',
    fieldSource: live.pool?.source ?? 'none',
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
    // Built only when the panel is open. See `live.compare`.
    comparison: live.compare && week && ctx ? buildComparison(ctx) : null,
    compareOpen: live.compare,
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

function poolModel() {
  const field = live.pool ? makeField(live.pool) : EMPTY_FIELD;
  return {
    field,
    describe: describePool(live.pool),
    abbrs: ABBRS,
    // Off the payload rather than off the field, because `makeField` returns
    // EMPTY_FIELD for a sheet that failed — and a sheet that failed is exactly
    // when the parser's complaints are the only useful thing on the screen.
    problems: live.pool?.problems ?? field.problems,
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
        : hash === '#/pool' ? poolModel()
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

/** A typed number, back inside what the setting can mean. */
function clampInt(raw, min, max, fallback) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

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

/**
 * The season as a calendar file.
 *
 * The recommendation is computed here rather than in the generator, because
 * running a strategy needs the registry and the generator is pure — and
 * because this is the one place that already knows which strategy is active.
 * An eliminated entry is skipped by `planReminders` rather than filtered here;
 * the policy about who deserves a reminder belongs beside the rest of it.
 */
function exportCalendar() {
  const season = live.week?.season ?? store.getSeason();
  const week = live.week?.week ?? null;
  const entries = store.getEntries();

  const strategyId = store.getState().strategyId ?? DEFAULT_STRATEGY_ID;
  const result = week ? run(strategyId, engineContext(), store.paramsFor(strategyId)) : null;
  const recommendations = Object.fromEntries(
    (result?.picks ?? []).map((p) => [p.entry, p.candidate]).filter(([, c]) => c),
  );

  const reminders = planReminders({
    season,
    week,
    entries,
    picks: store.getPicks(),
    games: live.week?.games ?? [],
    statuses: Object.fromEntries(entries.map((e) => [e.id, store.statusFor(e.id, season)])),
    recommendations,
    now: new Date(),
  });

  if (!reminders.length) {
    toast('Nothing to put on a calendar yet');
    return;
  }

  const body = toIcs(reminders, { now: new Date(), calendarName: `Deadpool ${season}` });
  const url = URL.createObjectURL(new Blob([body], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = icsFilename(season);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  const due = reminders.filter((r) => r.kind === 'deadline').length;
  toast(due ? `Calendar downloaded · ${due} pick${due === 1 ? '' : 's'} still due` : 'Calendar downloaded');
}

/**
 * The subscribable feed's address, on the clipboard.
 *
 * Built from `location.origin` rather than written down: the origin check in
 * scripts/check-shipped.mjs refuses a literal URL in shipped source, and
 * rightly — a hardcoded host is one deploy away from pointing somewhere the
 * app is not.
 *
 * `webcal:` rather than `https:` because it is what makes a calendar client
 * offer to *subscribe* rather than download a copy — which is the entire
 * difference between this and the button above it. The scheme is swapped on
 * the origin, so the host is still whatever this page was served from.
 *
 * Clipboard access can be refused (an insecure origin, a permission prompt
 * declined), so the address is shown in the toast either way. A copy button
 * that silently does nothing is worse than one that just tells you the answer.
 */
function copyFeedAddress() {
  const feed = `${location.origin.replace(/^https?:/, 'webcal:')}/api/calendar`;
  const done = () => toast('Feed address copied — add it in your calendar app');
  const fallback = () => toast(feed, { ms: 12_000 });

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(feed).then(done, fallback);
  } else {
    fallback();
  }
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
  compare: () => { live.compare = !live.compare; render(); },
  strategy: ({ id }) => { store.setStrategy(id); render(); },
  refresh: () => refresh(),
  export: () => exportBackup(),
  calendar: () => exportCalendar(),
  subscribe: () => copyFeedAddress(),
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
  } else if (bind === 'poolSize') {
    // Clamped here rather than trusted to the input's own min/max, which a
    // browser enforces for the spinner and not for typing or pasting.
    store.setSettings({ poolSize: clampInt(el.value, 2, 10_000, 250) });
  } else if (bind === 'buyIn') {
    store.setSettings({ buyIn: clampInt(el.value, 0, 100_000, 10) });
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

/**
 * A range should move its readout as it is dragged, not when it is released.
 *
 * The readout has to say the same thing the rendered one does, suffix included
 * — a percent control that renders "65%" and then drags to a bare "65" changes
 * units under somebody's thumb and puts the unit back when they let go. The
 * suffix travels on the element rather than being re-derived here, because the
 * strategy's parameter type is what decides it and only settings.js knows that.
 *
 * This line was `cond ? el.value : el.value`: both arms identical, so whatever
 * the condition was reaching for, it had already been lost.
 */
root.addEventListener('input', (event) => {
  const el = event.target.closest('input[type="range"]');
  if (!el) return;
  const readout = el.parentElement?.querySelector('.field__value');
  if (readout) readout.textContent = `${el.value}${el.dataset.suffix ?? ''}`;
});

onAction(root, ACTIONS);

/* ----------------------------------------------------------------- data -- */

/**
 * Settle whatever the data in hand can settle.
 *
 * Against cached weeks as well as the live one, which is the difference
 * between this working and half-working. The common path is fine either way —
 * pick on Sunday, open the app on Monday, the current week's payload holds the
 * finished games. The path that needs the cache is somebody who does not open
 * it until Thursday: by then "this week" has rolled over, and last week's picks
 * would sit pending forever with the answer sitting in localStorage.
 *
 * Only weeks with a pending pick in them are read back, so this is a couple of
 * cache reads on an ordinary day and none at all once a season is settled.
 */
function settlePending() {
  const season = live.week?.season ?? store.getSeason();
  const pending = store.getPicks().filter((p) => p.result === 'pending' && p.season === season);
  if (!pending.length) return;

  const weeks = [...new Set(pending.map((p) => p.week))];
  const games = [
    ...(live.week?.games ?? []),
    ...weeks.flatMap((w) => store.readCache('week', season, w)?.games ?? []),
  ];

  const { changed } = store.settleResults(games);
  if (!changed.length) return;

  render();
  const lost = changed.filter((c) => c.result === 'loss').length;
  toast(lost
    ? `${changed.length} result${changed.length === 1 ? '' : 's'} in — ${lost} lost`
    : `${changed.length} result${changed.length === 1 ? '' : 's'} in`);
}

async function refresh() {
  await loadWeek({}, (payload) => { live.week = payload; render(); settlePending(); });
  const season = await loadSeason(live.week?.season ?? store.getSeason());
  if (season) { live.season = season; render(); }

  // The sheet last, and never blocking: it is one screen's content plus an
  // input no strategy reads yet, and most deployments have none configured.
  // A failure here must not cost the week its render.
  loadPool(live.week?.season ?? store.getSeason(), (payload) => { live.pool = payload; render(); })
    .catch(() => null);
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
