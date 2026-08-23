/**
 * Settings — and the place the strategy registry proves itself.
 *
 * Nothing in this file knows what any strategy's parameters are. The controls
 * below are generated from each strategy's declared `params`, so adding a
 * strategy is a file in src/engine/strategies/ plus one line in the registry,
 * and its knobs appear here working, persisted per strategy, with their
 * ranges enforced. That is what "plug-and-play" was supposed to mean.
 *
 * The comparison table is the other half. This repository is called
 * algorithm-testing; running every registered strategy against the same week
 * and showing where they agree is the feature it is named after, and it is a
 * much stronger signal than any one of them alone.
 */

import { esc, cx } from '../ui/dom.js';
import { MEASURED, COLLIDES, measurementSummary } from '../engine/measured.js';
import { fairShare, potOf, expectedPerfectEntries, ratingCaveat } from '../engine/payout.js';
import { getStrategy } from '../engine/index.js';
import { icon } from '../ui/icons.js';

export function render(root, model) {
  const { state, strategies, activeStrategy, params, comparison, storage, alarm } = model;

  root.innerHTML = `
    <section class="view">
      <div class="section-head"><span class="eyebrow">Settings</span></div>
      ${alarm ? `<div class="alarm" role="alert"><b>Storage problem</b>${esc(alarm.detail)}</div>` : ''}
      ${state.blocked ? `<div class="alarm" role="alert"><b>Data from a newer version</b>${esc(state.blocked)}</div>` : ''}

      ${renderEntries(state)}
      ${renderPool(state)}
      ${renderStrategy(strategies, activeStrategy, params, state.poolSize)}
      ${comparison ? renderComparison(comparison, state.entries) : ''}
      ${renderAppearance(state)}
      ${renderReminders()}
      ${renderData(storage)}
      ${renderAbout()}
    </section>`;
  return root;
}

/* -------------------------------------------------------------- entries -- */

const renderEntries = (state) => `
  <div class="card">
    <div class="card__head"><h2 class="card__title">Your entries</h2></div>
    <div class="card__body">
      ${state.entries.map((e) => `
        <div class="field">
          <label class="field__label" for="entry-${esc(e.id)}">Entry ${esc(e.id)}</label>
          <input id="entry-${esc(e.id)}" type="text" value="${esc(e.name)}" maxlength="24"
                 data-bind="entryName" data-entry="${esc(e.id)}" autocomplete="off">
        </div>`).join('')}
      <p class="field__help">Names only. Which teams each entry has spent is worked out from your picks, so renaming one changes nothing else.</p>
    </div>
  </div>`;

/* ---------------------------------------------------------- pool rules -- */

/**
 * The two rules that vary between pools.
 *
 * Both are here rather than assumed because getting either wrong silently
 * misreports whether somebody is still in — which is the single thing this app
 * exists to tell them.
 */
const renderPool = (state) => `
  <div class="card">
    <div class="card__head"><h2 class="card__title">Pool rules</h2></div>
    <div class="card__body">
      <div class="field">
        <label class="field__label" for="strikes">Strikes allowed</label>
        <div class="field__row">
          <input id="strikes" type="range" min="1" max="3" step="1" value="${esc(state.strikesAllowed)}" data-bind="strikes">
          <span class="field__value">${esc(state.strikesAllowed)}</span>
        </div>
        <p class="field__help">One is the classic pool: a single loss and you are out.</p>
      </div>
      <div class="switch">
        <div>
          <div class="field__label">A tie counts as a loss</div>
          <p class="field__help">Off for this pool, which is the unusual side of it. Leaving it off means a tie advances you, so both teams in a tied game survive and the engine reads a pick as 1 &minus; the opponent's win chance. Ties are rare either way &mdash; measured at 0.2% of games &mdash; so this moves a figure by about a fifth of a point.</p>
        </div>
        <input type="checkbox" ${state.tieIsLoss ? 'checked' : ''} data-bind="tieIsLoss" aria-label="A tie counts as a loss">
      </div>

      <div class="field">
        <label class="field__label" for="poolSize">Entries in the pool</label>
        <div class="field__row">
          <input id="poolSize" type="number" min="2" max="10000" step="1" inputmode="numeric"
                 value="${esc(state.poolSize)}" data-bind="poolSize">
          <span class="field__value">${esc(fairPct(state.poolSize))}</span>
        </div>
        <p class="field__help">
          What one entry is worth playing at random, and the denominator every rating below is
          quoted against. It is also the size of the field the engine assumes when no pool sheet
          is configured &mdash; with one, the sheet's own count is used instead.
        </p>
      </div>

      <div class="field">
        <label class="field__label" for="buyIn">Buy-in</label>
        <div class="field__row">
          <input id="buyIn" type="number" min="0" max="100000" step="1" inputmode="numeric"
                 value="${esc(state.buyIn)}" data-bind="buyIn">
          <span class="field__value">${esc(money(potOf(state.poolSize, state.buyIn)))}</span>
        </div>
        <p class="field__help">
          The pot, for reading a share as money. Nothing is scored on it &mdash; a pick is chosen
          the same way at any stake.
        </p>
      </div>

      <p class="field__help">
        ${esc(perfectLine(state.poolSize))}
      </p>
    </div>
  </div>`;

/** A fair share as a percentage, which is what the ratings are multiples of. */
const fairPct = (poolSize) => {
  const s = fairShare(Number(poolSize));
  return s > 0 ? `${(s * 100).toFixed(2)}% each` : '—';
};

const money = (n) => (Number.isFinite(n) && n > 0 ? `$${Math.round(n).toLocaleString()}` : '—');

/**
 * How the pool is most likely to end, which is the fact that makes a second
 * entry worth holding at all.
 *
 * Below one expected perfect entry, deepest-splits is the normal ending rather
 * than an edge case. It rises fast with pool size, so this is stated from the
 * number the person actually entered rather than left as a constant.
 */
function perfectLine(poolSize) {
  const n = expectedPerfectEntries(Number(poolSize));
  if (!Number.isFinite(n)) return '';
  const rounded = n.toFixed(2);
  return n < 1
    ? `At this size about ${rounded} entries should finish all 18 weeks unbeaten — under one, so `
      + 'the pot most likely splits among whoever gets deepest rather than among the perfect. That '
      + 'is the regime a second entry is worth holding in.'
    : `At this size about ${rounded} entries should finish all 18 weeks unbeaten, so a perfect `
      + 'season is the likely ending and the pot is split among however many manage it.';
}

/* ------------------------------------------------------------ strategy -- */

/**
 * The picker, ordered by what the backtest found rather than by import order.
 *
 * Six strategies listed as equals, each with an equally confident blurb, is
 * the app hiding the one thing the research established -- and three of the
 * six put both entries on the same team, which measured *worse than not
 * playing*. The numbers come from engine/measured.js, which is the single
 * place they are written down.
 *
 * A strategy nobody has raced is shown as unmeasured rather than omitted or
 * quietly ranked last on a made-up number. Every one of the six currently has
 * a figure, so that branch is dormant -- and it stays, because the next
 * strategy added will land in it before it has been run.
 */
function renderStrategy(strategies, active, params, poolSize) {
  const ordered = [...strategies].sort(byMeasured);
  // Computed once. It was read straight off `state`, which this function has
  // never been passed — a bare identifier rather than a call, so the shipped-
  // code check (which only resolves calls) could not see it and the screen
  // threw on render. Hence the argument.
  const caveat = ratingCaveat(poolSize);
  return `
    <div class="card">
      <div class="card__head"><h2 class="card__title">How picks are chosen</h2></div>
      <div class="card__body">
        <p class="note">${esc(measurementSummary())}</p>
        ${caveat ? `<p class="note note--warn">${esc(caveat)}</p>` : ''}
        ${ordered.map((s) => renderChoice(s, active)).join('')}

        ${active.params?.length ? `
          <div class="label stack-top">Settings for this strategy</div>
          ${active.params.map((p) => renderParam(p, params[p.key])).join('')}` : ''}
      </div>
    </div>`;
}

/** Best measured first; anything unmeasured after all of it, in its own order. */
function byMeasured(a, b) {
  const x = scoreOf(a.id);
  const y = scoreOf(b.id);
  if (x !== null && y !== null) return y - x;
  if (x !== null) return -1;
  if (y !== null) return 1;
  return 0;
}

const scoreOf = (id) => {
  const m = MEASURED[id];
  return m && Number.isFinite(m.xFair) ? m.xFair : null;
};

/**
 * One choice.
 *
 * The measurement note is shown only on the selected one, and that is a
 * lesson from looking at the page rather than at the markup. Six strategies
 * with a name, a score, a blurb, a warning and a note each ran to four phone
 * screens, and the list stopped being scannable -- which is the one job a
 * picker has. The warning stays on all of them, because it is one line and it
 * is the whole finding; the commentary belongs to whatever you have chosen.
 */
function renderChoice(s, active) {
  const m = MEASURED[s.id];
  const on = s.id === active.id;
  return `
    <button type="button" class="${cx('choice', on && 'choice--on')}"
            data-act="strategy" data-id="${esc(s.id)}" data-key="strategy-${esc(s.id)}">
      <span class="choice__tick">${on ? icon('check', 16) : ''}</span>
      <span>
        <span class="choice__name">${esc(s.name)}${renderScore(s.id, m)}</span>
        <span class="choice__blurb">${esc(s.blurb)}</span>
        ${COLLIDES(s.id) ? '<span class="choice__measured choice__measured--warn">Puts both entries on the same team every week.</span>' : ''}
        ${on && m?.note ? `<span class="choice__measured choice__measured--note">${esc(resolveNames(m.note))}</span>` : ''}
      </span>
    </button>`;
}

/**
 * `{joint}` in a note becomes whatever that strategy is currently called.
 *
 * The alternative is writing the display name into the note, which is the
 * same fact in two files -- and it has already gone wrong once, when a rename
 * left every note quoting a strategy by a name it no longer had. An id that
 * no longer resolves is left visible rather than blanked, so a broken
 * reference looks broken instead of looking like a sentence with a hole in it.
 */
const resolveNames = (note) =>
  note.replace(/\{(\w+)\}/g, (whole, id) => getStrategy(id)?.name ?? whole);

/**
 * The score, as a multiple of a fair share of the pot.
 *
 * A multiple rather than a rank, because the gaps are what matter and the top
 * three are a statistical dead heat -- calling one of them "1st" would invent
 * a difference the measurement explicitly did not find.
 *
 * The tint is on `samePick` rather than on the number, and that is the whole
 * lesson of the run. 0.98 is not distinguishable from a fair share, so
 * marking it as a loser would claim something the measurement did not find;
 * "both entries on the same team, every week of 2,500 seasons" is not an
 * estimate at all. It is also the thing that actually separates the six.
 */
function renderScore(id, m) {
  // Unmeasured is `null` for the whole entry, and a missing id is undefined.
  // The number is checked rather than assumed present: a settings screen that
  // throws is a settings screen nobody can get out of, and this is the one
  // field here that comes from a file somebody edits by hand.
  if (!m || !Number.isFinite(m.xFair)) return '<span class="pill pill--quiet">not measured</span>';
  return `<span class="${cx('pill', COLLIDES(id) && 'pill--bad')}">${m.xFair.toFixed(2)}\u00d7 fair</span>`;
}

/**
 * One control, from a declaration.
 *
 * Every branch here is a `type` the registry validates, so a strategy that
 * declares something unknown fails the suite rather than rendering a control
 * with no behaviour.
 */
function renderParam(p, value) {
  const id = `param-${p.key}`;
  const shown = p.type === 'percent' ? `${value}%` : String(value);

  if (p.type === 'bool') {
    return `
      <div class="switch">
        <div><div class="field__label">${esc(p.label)}</div>${p.help ? `<p class="field__help">${esc(p.help)}</p>` : ''}</div>
        <input type="checkbox" ${value ? 'checked' : ''} data-bind="param" data-key="${esc(p.key)}" aria-label="${esc(p.label)}">
      </div>`;
  }

  if (p.type === 'choice') {
    return `
      <div class="field">
        <label class="field__label" for="${id}">${esc(p.label)}</label>
        <select id="${id}" data-bind="param" data-key="${esc(p.key)}">
          ${p.options.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
        ${p.help ? `<p class="field__help">${esc(p.help)}</p>` : ''}
      </div>`;
  }

  const step = p.step ?? (p.type === 'int' ? 1 : 0.01);
  // The suffix rides on the element so the live readout in app.js can match
  // what is rendered here. Re-deriving it there would mean the parameter's
  // declared type in two places, and the drag would show bare digits while a
  // percent control was mid-slide.
  const suffix = p.type === 'percent' ? '%' : '';
  return `
    <div class="field">
      <label class="field__label" for="${id}">${esc(p.label)}${p.unit ? ` (${esc(p.unit)})` : ''}</label>
      <div class="field__row">
        <input id="${id}" type="range" min="${esc(p.min ?? 0)}" max="${esc(p.max ?? 100)}" step="${esc(step)}"
               value="${esc(value)}" data-bind="param" data-key="${esc(p.key)}" data-suffix="${esc(suffix)}">
        <span class="field__value">${esc(shown)}</span>
      </div>
      ${p.help ? `<p class="field__help">${esc(p.help)}</p>` : ''}
    </div>`;
}

/* ---------------------------------------------------------- comparison -- */

/**
 * Every registered strategy over this same week.
 *
 * Where they agree is worth more than any of them alone; where they diverge is
 * the interesting part of a week and the thing worth a second look before
 * committing.
 */
function renderComparison(comparison, entries) {
  const { results, agreement } = comparison;
  return `
    <div class="card">
      <div class="card__head">
        <h2 class="card__title">What each one would pick</h2>
        ${entries.map((e) => {
          const a = agreement[e.id];
          return a ? `<span class="${cx('chip', a.unanimous ? 'chip--alive' : 'chip--warn')}">${esc(e.name)}: ${a.unanimous ? 'agreed' : `${a.distinct} views`}</span>` : '';
        }).join('')}
      </div>
      <div>
        ${results.map((r) => `
          <div class="${cx('trow', entries.length === 2 ? 'trow--compare' : entries.length === 1 ? 'trow--compare-1' : 'trow--compare-3')}">
            <span class="trow__week trow__name">${esc(r.strategyName ?? r.strategyId)}</span>
            ${entries.map((e) => {
              const p = r.picks.find((x) => x.entry === e.id);
              const team = p?.candidate?.teamAbbreviation ?? null;
              return `<span class="tcell"><span class="tcell__abbr">${esc(team ?? '—')}</span></span>`;
            }).join('')}
          </div>`).join('')}
      </div>
      <div class="card__body">
        <p class="field__help">All ${esc(results.length)} run on the same board and the same used-teams history. Only the one selected above decides what the Week screen recommends.</p>
      </div>
    </div>`;
}

/* --------------------------------------------------------- appearance -- */

const renderAppearance = (state) => `
  <div class="card">
    <div class="card__head"><h2 class="card__title">Appearance</h2></div>
    <div class="card__body">
      <div class="field">
        <label class="field__label" for="theme">Theme</label>
        <select id="theme" data-bind="theme">
          <option value="system" ${state.theme === 'system' ? 'selected' : ''}>Match the device</option>
          <option value="dark" ${state.theme === 'dark' ? 'selected' : ''}>Dark</option>
          <option value="light" ${state.theme === 'light' ? 'selected' : ''}>Light</option>
        </select>
        <p class="field__help">Dark is the default because this gets opened on a phone on a Sunday morning.</p>
      </div>
    </div>
  </div>`;

/* --------------------------------------------------------------- data -- */

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/* ------------------------------------------------------------ reminders -- */

/**
 * A calendar file, because a browser cannot set an alarm.
 *
 * The honest sentence is the one about *why* this is a download rather than a
 * notification toggle, and it stays on screen: a web app has no way to schedule
 * anything for a future time without a push server, and a push server would be
 * the first thing here to learn what you picked. The calendar app can already
 * do the job, offline, without telling anybody.
 *
 * "Re-export after you pick" is the cost of a snapshot and is said plainly.
 * Hiding it would produce the failure this whole app is organised against —
 * something that looks exactly like working while quietly showing last week's
 * answer.
 */
const renderReminders = () => `
  <div class="card">
    <div class="card__head"><h2 class="card__title">Reminders</h2></div>
    <div class="card__body">
      <p class="field__help">
        The most common way to lose a survivor pool is forgetting to pick. This exports
        your season as a calendar file — every pick you have made, and an alarm the day
        before and again ninety minutes before kickoff for any week you have not.
        The reminder carries the current recommendation in it, so it can be acted on
        without opening anything.
      </p>
      <div class="btn-row">
        <button type="button" class="btn" data-act="calendar">${icon('clock', 16)} Add to calendar</button>
      </div>
      <p class="field__help">
        A snapshot, not a subscription — re-export after you pick, or when the board moves.
        Nothing is uploaded.
      </p>

      <div class="field">
        <div class="field__label">Or subscribe to the deadlines</div>
        <p class="field__help">
          Every week's lock time, as a calendar you add once. It stays right for the whole
          season without you doing anything, because kickoff times are known months ahead —
          and it carries no picks, so nothing about you is on the server.
        </p>
        <div class="btn-row">
          <button type="button" class="btn btn--ghost" data-act="subscribe">${icon('download', 16)} Copy feed address</button>
        </div>
        <p class="field__help">
          The reminder tells you a week is closing; the app tells you what to take. That split is
          deliberate — a calendar refreshes on its own schedule, often only once a day, so a pick
          carried in a feed would be showing you Wednesday's answer on Sunday morning.
        </p>
      </div>
    </div>
  </div>`;

const renderData = (storage) => `
  <div class="card">
    <div class="card__head"><h2 class="card__title">Your data</h2></div>
    <div class="card__body">
      <p class="field__help">
        Everything lives in this browser on this device. Nothing is sent anywhere — the only request this
        app makes is to its own origin, for the schedule, and that request carries nothing about you.
        There is no account and no backup but the one you take.
      </p>
      <div class="meta">
        <span>${esc(kb(storage.total))} used</span>
        <span>· ${esc(kb(storage.cache))} of that is cached schedule</span>
      </div>
      <div class="btn-row">
        <button type="button" class="btn" data-act="export">${icon('download', 16)} Export</button>
        <button type="button" class="btn" data-act="import">${icon('upload', 16)} Import</button>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn--ghost" data-act="clear-cache">Clear cached weeks</button>
        <button type="button" class="btn btn--danger" data-act="erase">${icon('trash', 16)} Erase everything</button>
      </div>
      <p class="field__help">Clearing the cache only drops ESPN's data, which comes back on the next connection. Erasing removes your picks, and cannot be undone.</p>
      <input type="file" accept="application/json,.json" data-bind="importFile" class="sr">
    </div>
  </div>`;

const renderAbout = () => `
  <div class="card">
    <div class="card__head"><h2 class="card__title">About</h2></div>
    <div class="card__body">
      <p class="field__help">
        Deadpool wraps the survivor-picker engine — the same win-probability, future-value and joint-optimisation
        code, ported to run in the browser and held to the original line for line by a golden test suite.
        It recommends; it never submits a pick anywhere. You still make the pick in your pool.
      </p>
    </div>
  </div>`;
