/**
 * The Week screen — the one that has to work.
 *
 * Every decision here answers one scenario: it is 12:35 Eastern, kickoff is in
 * twenty-five minutes, there is one bar of signal, and two picks have to be
 * made that will not be regretted. Anything that does not serve that is a
 * second-screen concern and lives on another tab.
 *
 * Which produces four rules that the rest of this file is:
 *
 *   The answer is above the fold. Both entries, both recommendations, no
 *   navigation, and no spinner drawn over the top of a cached board.
 *
 *   Status is the headline, not a detail. "Both alive · Week 3 of 18" is the
 *   first thing on the page, and an eliminated entry stops being given advice.
 *
 *   Deadlines are per game and shown. A pick's window closes at its own
 *   kickoff, not at some pool-wide time, and a team whose game has started is
 *   greyed out with the reason attached rather than silently vanishing from
 *   the list — which is what the Python does, correctly and invisibly.
 *
 *   An estimate never looks like a measurement. ESPN's own model and a
 *   spread-derived guess are different epistemic states and get different
 *   colours, a different chip, and a different bar.
 */

import { esc, cx } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { f1 } from '../engine/fmt.js';
import { describeSource, nextLock, formatCountdown } from '../data/source.js';

const pct = (v) => (v === null || v === undefined ? '—' : `${f1(v)}%`);

/**
 * A kickoff, as short as it can be and still unambiguous.
 *
 * "Sun 5:00p" rather than "Sun 5:00 PM": the fixture line carries the
 * opponent, the time and the spread, and at 11.5px mono the longer form pushed
 * it onto a second row on exactly the cards with a two-part spread — which
 * made two entry cards different heights for no reason a reader could see.
 */
const kickoff = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString([], { weekday: 'short' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .replace(/\s?([AP])M/i, (_m, ap) => ap.toLowerCase());
  return `${day} ${time}`;
};

export function render(root, model) {
  const { payload, result, headline, entries, season, week, strategy, alarm } = model;
  const games = payload?.games ?? [];

  if (!games.length) return renderEmpty(root, payload);

  const lock = nextLock(games);
  const provenance = describeSource(payload);

  root.innerHTML = `
    <section class="view">
      ${renderHeadline(headline, season, week)}
      ${alarm ? renderAlarm(alarm) : ''}
      ${renderDeadline(lock)}
      ${(result?.warnings ?? []).map(renderWarning).join('')}
      ${entries.map((entry) => renderEntry({ entry, model })).join('')}
      ${renderUnavailable(payload)}
      ${renderProvenance(provenance, strategy, result)}
    </section>`;

  return root;
}

/* ------------------------------------------------------------- headline -- */

function renderHeadline(headline, season, week) {
  const out = headline.aliveCount === 0;
  return `
    <div class="${cx('status', out && 'status--out')}">
      <span class="status__text">${esc(headline.text)}</span>
      <span class="status__week">Week ${week} · ${season}</span>
    </div>`;
}

/* ------------------------------------------------------------- deadline -- */

function renderDeadline(lock) {
  if (!lock) {
    return `
      <div class="deadline deadline--gone">
        ${icon('clock', 18)}
        <div>
          <div class="label">Board closed</div>
          <div class="deadline__what">Every game this week has kicked off. Nothing left to pick.</div>
        </div>
      </div>`;
  }

  const soon = lock.in < 3 * 3600e3;
  const g = lock.game;
  return `
    <div class="${cx('deadline', soon && 'deadline--soon')}">
      ${icon('clock', 18)}
      <div>
        <div class="label">Next lock</div>
        <div class="deadline__what">${esc(g.away.abbreviation ?? '?')} at ${esc(g.home.abbreviation ?? '?')} · ${esc(kickoff(g.startDate))}${lock.remaining > 1 ? ` · ${lock.remaining} open` : ''}</div>
      </div>
      <span class="deadline__clock">${esc(formatCountdown(lock.in, lock.at))}</span>
    </div>`;
}

/* -------------------------------------------------------------- entries -- */

function renderEntry({ entry, model }) {
  const { result, statuses, picksThisWeek, week } = model;
  const status = statuses[entry.id];
  const recorded = picksThisWeek[entry.id] ?? null;
  const suggestion = (result?.picks ?? []).find((p) => p.entry === entry.id) ?? null;

  const head = `
    <div class="card__head">
      <h2 class="card__title">${esc(entry.name)}</h2>
      ${renderStatusChip(status)}
    </div>`;

  if (!status.alive) {
    return `
      <article class="card card--out">
        ${head}
        <div class="card__body">
          <p class="empty empty--flush">Out in week ${status.eliminatedWeek}. Nothing more to pick this season.</p>
        </div>
      </article>`;
  }

  if (recorded) return `<article class="card">${head}${renderRecorded(recorded, entry, week)}</article>`;

  if (!suggestion || !suggestion.candidate) {
    return `
      <article class="card">
        ${head}
        <div class="card__body">
          <div class="empty empty--inset">
            <h2>No legal pick</h2>
            <p>Every team still available to this entry has either been used or has already kicked off.</p>
          </div>
        </div>
      </article>`;
  }

  const c = suggestion.candidate;
  const locked = hasStarted(c);

  return `
    <article class="card card--pick">
      ${head}
      <div class="card__body">
        ${renderCandidate(c)}
        <div class="btn-row">
          <button type="button" class="btn btn--primary btn--wide" data-act="take"
                  data-entry="${esc(entry.id)}" data-team="${esc(c.teamAbbreviation)}" ${locked ? 'disabled' : ''}>
            ${icon('check', 16)} ${locked ? 'Kicked off' : `Take ${esc(c.teamAbbreviation)}`}
          </button>
        </div>
      </div>
      ${renderWhy(suggestion, entry)}
      ${renderAlternatives(result, entry)}
    </article>`;
}

/**
 * Has this candidate's own game kicked off?
 *
 * Per game, not per week: a pick's window closes at its own kickoff. The
 * week's next lock is a different fact and is drawn separately, which is why
 * this took a `lock` argument it then used as `lock ? Date.now() : Date.now()`
 * — both arms the same expression, so the argument decided nothing. Gone,
 * rather than left as a parameter somebody would later try to make matter.
 */
const hasStarted = (candidate) =>
  Boolean(candidate.startDate) && Date.parse(candidate.startDate) <= Date.now();

function renderStatusChip(status) {
  if (!status.alive) return `<span class="chip chip--out"><i class="chip__dot"></i>Out</span>`;
  return `<span class="chip chip--alive"><i class="chip__dot"></i>${esc(status.record)}</span>`;
}

/**
 * The recommendation itself.
 *
 * Everything that used to be a chip below the bar is on the line under the
 * team, because two entry cards have to fit on a phone above the fold and a
 * row of chips was forty pixels each of saying what the numbers already say.
 *
 * The provenance survives that compression rather than being dropped, and it
 * moves to the one place it cannot be missed: the label under the figure it
 * qualifies. `EST` next to a percentage is unambiguous in a way a separate
 * chip two rows down never was, and the bar changes colour with it.
 */
/**
 * Where a percentage came from, in the three words the card has room for.
 *
 * Three, not two. This read `estimated ? 'est' : 'espn'`, which was true while
 * there were only two sources — and the moment a de-vigged moneyline became a
 * third, that binary would have labelled a market price "espn". Naming the
 * wrong source is worse than naming none: this card's whole claim is that it
 * says what it is working from.
 *
 * Note that `market` is deliberately not amber. Amber means "this came out of
 * a rule of thumb"; a moneyline came out of a book.
 */
function sourceLabel(source) {
  if (source === 'moneyline') return 'market';
  if (source === 'spread_estimate') return 'est';
  return 'espn';
}

function renderCandidate(c) {
  const estimated = c.winPctIsEstimated || c.winPctSource === 'spread_estimate';
  const unknown = c.winPct === null || c.winPct === undefined;
  const fill = unknown ? 0 : c.winPct / 100;

  const line = [
    `vs ${esc(c.opponentAbbreviation ?? '?')}`,
    c.startDate ? esc(kickoff(c.startDate)) : null,
    c.spreadDetail ? esc(c.spreadDetail) : null,
  ].filter(Boolean).join(' · ');

  return `
    <div class="pick">
      <div class="pick__team">
        <span class="pick__abbr">${esc(c.teamAbbreviation)}</span>
        <span class="pick__name">${esc(c.teamName ?? '')}</span>
        <span class="pick__opp">${line}</span>
      </div>
      <div class="pick__prob">
        ${unknown
          ? '<span class="pick__pct pick__unknown">no line</span><span class="pick__pct-label">no line published</span>'
          : `<span class="${cx('pick__pct', estimated && 'pick__pct--est')}">${esc(pct(c.winPct))}</span>
             <span class="pick__pct-label">to win · ${sourceLabel(c.winPctSource)}</span>`}
      </div>
      <div class="${cx('bar', estimated && 'bar--est')}"><div class="bar__fill" data-fill="${fill}"></div></div>
    </div>`;
}

/* ------------------------------------------------------------ why panel -- */

function renderWhy(suggestion, entry) {
  const factors = suggestion.factors ?? [];
  if (!factors.length && !suggestion.reasoning) return '';
  return `
    <details class="why">
      <summary class="why__toggle">Why ${esc(entry.name)} gets this ${icon('chevron', 16)}</summary>
      <div class="why__body">
        ${factors.map(renderFactor).join('')}
        ${suggestion.reasoning ? `<p class="why__prose">${esc(suggestion.reasoning)}</p>` : ''}
      </div>
    </details>`;
}

const renderFactor = (f) => `
  <div class="${cx('why__row', f.weight > 0 && 'why__row--good', f.weight < 0 && 'why__row--bad')}">
    <span class="why__label">${esc(f.label)}</span>
    <span class="why__value">${esc(f.value ?? '—')}</span>
    ${f.note ? `<span class="why__note">${esc(f.note)}</span>` : ''}
  </div>`;

/* ---------------------------------------------------------- alternatives -- */

/**
 * The rest of the board, behind a details element rather than a modal.
 *
 * A sheet that covers the recommendation makes comparing the two impossible on
 * a phone, which is the only screen this is used on.
 */
function renderAlternatives(result, entry) {
  const list = (result?.candidates?.[entry.id] ?? []).slice(1, 9);
  if (!list.length) return '';
  return `
    <details class="why">
      <summary class="why__toggle">Pick something else ${icon('chevron', 16)}</summary>
      <div class="why__body">
        <div class="alts">
          ${list.map((c) => {
            const started = hasStarted(c);
            const est = c.winPctIsEstimated || c.winPctSource === 'spread_estimate';
            return `
              <button type="button" class="${cx('alt', est && 'alt--est', c.winPct === null && 'alt--none')}"
                      data-act="take" data-entry="${esc(entry.id)}" data-team="${esc(c.teamAbbreviation)}"
                      data-key="${esc(entry.id)}-${esc(c.teamAbbreviation)}" ${started ? 'disabled' : ''}>
                <span class="alt__abbr">${esc(c.teamAbbreviation)}</span>
                <span class="alt__opp">vs ${esc(c.opponentAbbreviation ?? '?')}${started ? ' · kicked off' : ''}</span>
                <span class="alt__pct">${esc(pct(c.winPct))}</span>
              </button>`;
          }).join('')}
        </div>
        <p class="field__help">Any team is pickable. The app recommends; you decide.</p>
      </div>
    </details>`;
}

/* ------------------------------------------------------------- recorded -- */

/**
 * A pick already made.
 *
 * The result controls appear once the game has kicked off, and not before —
 * an app that asks "did they win?" while the game is still in the first
 * quarter is inviting the one mistake that cannot be undone by waiting.
 */
function renderRecorded(pick, entry, week) {
  const started = pick.startDate ? Date.parse(pick.startDate) <= Date.now() : true;
  const settled = pick.result !== 'pending';

  return `
    <div class="card__body">
      <div class="pick">
        <div class="pick__team">
          <span class="pick__abbr">${esc(pick.team)}</span>
          <span class="pick__name">${esc(pick.opponent ? `vs ${pick.opponent}` : '')}</span>
          <span class="pick__opp">Picked for week ${week}${pick.strategyId ? ` · ${esc(pick.strategyId)}` : ''}</span>
        </div>
        <div class="pick__prob">
          ${pick.snapshot?.winPct !== undefined && pick.snapshot?.winPct !== null
            ? `<span class="pick__pct">${esc(pct(pick.snapshot.winPct))}</span><span class="pick__pct-label">when picked</span>`
            : ''}
        </div>
      </div>
      ${settled ? `<div class="btn-row"><span class="chip ${pick.result === 'win' ? 'chip--alive' : pick.result === 'loss' ? 'chip--out' : 'chip--warn'}">${esc(pick.result)}</span></div>` : ''}
      ${started && !settled ? `
        <div class="label">How did it go?</div>
        <div class="btn-row">
          <button type="button" class="btn" data-act="result" data-id="${esc(pick.id)}" data-result="win" data-key="${esc(pick.id)}-win">Won</button>
          <button type="button" class="btn" data-act="result" data-id="${esc(pick.id)}" data-result="loss" data-key="${esc(pick.id)}-loss">Lost</button>
          <button type="button" class="btn" data-act="result" data-id="${esc(pick.id)}" data-result="tie" data-key="${esc(pick.id)}-tie">Tied</button>
        </div>` : ''}
      ${!started ? `
        <div class="btn-row">
          <button type="button" class="btn btn--ghost" data-act="unpick" data-id="${esc(pick.id)}" data-entry="${esc(entry.id)}">
            ${icon('undo', 16)} Change
          </button>
        </div>` : ''}
    </div>`;
}

/* ---------------------------------------------------------------- notes -- */

/**
 * Teams that would have been options but for a game already under way.
 *
 * The Python drops these with a bare `continue`. Counting them out loud is the
 * difference between a list that got shorter and a list that got shorter for a
 * reason somebody can see.
 */
function renderUnavailable(payload) {
  const started = (payload?.games ?? []).filter((g) => g.state && g.state !== 'pre');
  if (!started.length) return '';
  const names = started.slice(0, 4).map((g) => `${g.away.abbreviation}/${g.home.abbreviation}`).join(', ');
  return `
    <div class="warn">
      ${icon('alert', 18)}
      <div>${started.length} game${started.length === 1 ? '' : 's'} already under way — ${esc(names)}${started.length > 4 ? ` and ${started.length - 4} more` : ''}. Those teams are off the board for this week.</div>
    </div>`;
}

const renderWarning = (w) => `
  <div class="${cx('warn', w.level === 'danger' && 'warn--danger')}">
    ${icon('alert', 18)}
    <div>${esc(w.text)}</div>
  </div>`;

const renderAlarm = (alarm) => `
  <div class="alarm" role="alert">
    <b>Not saved</b>
    ${esc(alarm.detail)}
  </div>`;

function renderProvenance(provenance, strategy, result) {
  return `
    <div class="meta">
      <span class="${cx('meta__dot', provenance.tone === 'cache' && 'meta__dot--cache', provenance.tone === 'offline' && 'meta__dot--offline')}"></span>
      <span>${esc(provenance.text)}</span>
      ${strategy ? `<span>· ${esc(strategy.name)}</span>` : ''}
      ${result?.considered ? `<span>· ${result.considered} option${result.considered === 1 ? '' : 's'} weighed</span>` : ''}
    </div>`;
}

function renderEmpty(root, payload) {
  const none = !payload || payload.source === 'none';
  root.innerHTML = `
    <section class="view">
      <div class="empty">
        <h2>${none ? 'Nothing to show yet' : 'No games this week'}</h2>
        <p>${none
          ? 'This device has no cached week and the schedule could not be reached. Open the app once with a connection and it will work offline after that.'
          : 'The schedule has no games for this week — usually a bye in the calendar rather than a problem.'}</p>
        <div class="btn-row btn-row--center">
          <button type="button" class="btn" data-act="refresh">Try again</button>
        </div>
      </div>
    </section>`;
  return root;
}
