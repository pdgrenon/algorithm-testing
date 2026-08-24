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
 *   Status is the headline, not a detail. "Both alive · Week 3 · 2026" is the
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
  const { payload, result, headline, entries, season, week, strategy, alarm, comparison, compareOpen } = model;
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
      ${renderComparison(comparison, entries, compareOpen)}
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
      ${renderModel(c)}
    </div>`;
}

/**
 * What the probability model did, under the number it produced.
 *
 * Three cells at most, and the rule for each is "only when it has something to
 * say". This is the one screen with a fold to defend, so a row of dashes
 * explaining that two optional features are switched off would be exactly the
 * second-screen content the file header rules out.
 *
 *   the line    always, when there is a probability at all. It is the market's
 *               own view in the units the market uses, and it is worth reading
 *               next to a percentage — 91% and "-8.5" are the same fact, and
 *               people have calibrated intuitions about one of them.
 *   nfelo       only when nfelo has rated this game. Most of a lookahead
 *               horizon is legitimately unrated, and in September most of the
 *               season is.
 *   bias        only when it is non-zero, which means the correction is on.
 *
 * ── Two sign conventions, deliberately different ────────────────────────
 *
 * The line is drawn in **betting convention**: a favourite is negative. The
 * engine works in "points the home side is favoured by", which is the opposite
 * sign, and it stays that way inside the engine because that is the sign the
 * curve was fitted in. It is flipped here, at the edge, because the card also
 * carries the posted spread two lines up — and a model line of "+6.8" sitting
 * above a posted "KC -6.5" reads as a contradiction rather than agreement.
 *
 * The divergence is drawn **relative to this team**, where the engine keeps it
 * relative to the home team. That is not a disagreement either: one number per
 * game is what makes it comparable across a board, and one number per *card*
 * is what makes it readable on a card. Positive means nfelo likes this team
 * more than the market does, whichever side of the game it is on.
 */
function renderModel(c) {
  if (c.winPct === null || c.winPct === undefined) return '';
  if (c.marketSpread === null || c.marketSpread === undefined) return '';

  // Engine: points the home side is favoured by. Card: this team's line, in
  // betting convention.
  const teamFavouredBy = c.isHome ? c.marketSpread : -c.marketSpread;
  const cells = [
    // "implied", and the precision is the point.
    //
    // This is the line implied by the win probability actually in use, before
    // the Elo blend touches it. It is *not* the book's line -- that is already
    // on the card two rows up, as "NYJ -10" -- and the two routinely differ,
    // because the probability at the top of this app's ladder is ESPN's own
    // model rather than the market's price. Calling this one "market line"
    // claimed the book said something it did not, on a card that was
    // simultaneously showing what the book actually said.
    //
    // The gap between the two is real information: it says how far ESPN's
    // model is from the posted line on this game. Worth showing, not worth
    // mislabelling.
    { label: 'implied line', value: signed(-teamFavouredBy) },
  ];

  if (c.divergence !== null && c.divergence !== undefined) {
    const teamDivergence = c.isHome ? c.divergence : -c.divergence;
    cells.push({
      label: 'nfelo',
      value: `${signed(teamDivergence)} pts`,
      tone: teamDivergence > 0 ? 'good' : teamDivergence < 0 ? 'bad' : null,
    });
  }

  // Two decimals, and only when there is something to see at two decimals.
  //
  // The shipped table's largest adjustment is 0.17 points and its mean is
  // 0.05, so at one decimal most teams read "0.0" -- a cell that occupies a
  // third of the row to say nothing, which is exactly what the first
  // photograph of this showed. Rounding decides whether it draws, so the
  // threshold is the display's own precision rather than a separate constant
  // that could drift away from it.
  const bias = Math.round(c.teamBiasPct * 100) / 100;
  if (bias) {
    cells.push({
      label: c.isHome ? 'home bias' : 'away bias',
      value: `${signed(bias, 2)} pts`,
      tone: bias > 0 ? 'good' : 'bad',
    });
  }

  return `
    <div class="model">
      ${cells.map((cell) => `
        <div class="${cx('model__cell', cell.tone && `model__cell--${cell.tone}`)}">
          <span class="model__value">${esc(cell.value)}</span>
          <span class="model__label">${esc(cell.label)}</span>
        </div>`).join('')}
    </div>`;
}

/**
 * A number with its sign always shown, and a real minus rather than a hyphen.
 *
 * The sign is the content here — "nfelo 3.7" says nothing without it — so it
 * is never dropped on a positive. U+2212 because a hyphen at this size next to
 * a digit reads as punctuation.
 */
function signed(value, places = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  const magnitude = Math.abs(rounded).toFixed(places);
  if (Object.is(rounded, -0) || rounded === 0) return magnitude;
  return `${rounded > 0 ? '+' : '−'}${magnitude}`;
}

/* ------------------------------------------------------------ why panel -- */

function renderWhy(suggestion, entry) {
  const factors = suggestion.factors ?? [];
  if (!factors.length && !suggestion.reasoning) return '';
  return `
    <details class="why" id="why-${esc(entry.id)}">
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
    <details class="why" id="alts-${esc(entry.id)}">
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

/* ---------------------------------------------------------- comparison -- */

/**
 * What every strategy would pick, this week, on this board.
 *
 * This repository is called algorithm-testing, and running all of them against
 * one week is the feature it is named after. It used to live on the Settings
 * screen, which was wrong twice over: it was the only reference content on a
 * page of controls -- nothing in it changes anything -- and it answers a
 * question about *this week's pick*, which is this screen's job. Where they
 * agree is worth more than any one of them alone; where they diverge is the
 * part of a week worth a second look before committing.
 *
 * Collapsed, and genuinely not computed until it is opened. `compareAll` runs
 * every registered strategy -- 284 ms against a screen that renders in about
 * 100 -- so building it eagerly would have spent most of the beam-width fix on
 * a table nobody had asked to see. The summary carries `data-act="compare"`,
 * which flips a flag in app.js and re-renders; `comparison` is null until then
 * and the body is empty.
 */
function renderComparison(comparison, entries, open) {
  return `
    <details class="why" id="compare"${open ? ' open' : ''}>
      <summary class="why__toggle" data-act="compare">What every strategy would pick ${icon('chevron', 16)}</summary>
      <div class="why__body">
        ${comparison ? renderComparisonBody(comparison, entries) : ''}
      </div>
    </details>`;
}

function renderComparisonBody(comparison, entries) {
  const { results, agreement } = comparison;
  return `
    ${entries.map((e) => {
      const a = agreement[e.id];
      // "2 views" said nothing: it was the count of distinct teams the
      // strategies chose for this entry, which nobody could infer from the
      // word -- and it collided with the strategy actually named `distinct`.
      // The chip has one job, so it says it.
      return a ? `<span class="${cx('chip', a.unanimous ? 'chip--alive' : 'chip--warn')}">${esc(e.name)}: ${a.unanimous ? 'all agree' : `${a.distinct} different picks`}</span>` : '';
    }).join('')}
    ${results.map((r) => `
      <div class="${cx('trow', entries.length === 2 ? 'trow--compare' : entries.length === 1 ? 'trow--compare-1' : 'trow--compare-3')}">
        <span class="trow__week trow__name">${esc(r.strategyName ?? r.strategyId)}</span>
        ${entries.map((e) => {
          const p = r.picks.find((x) => x.entry === e.id);
          const team = p?.candidate?.teamAbbreviation ?? null;
          return `<span class="tcell"><span class="tcell__abbr">${esc(team ?? '\u2014')}</span></span>`;
        }).join('')}
      </div>`).join('')}
    <p class="field__help">All ${esc(results.length)} on the same board and the same used-teams history. Only the one selected in Settings decides the recommendation above.</p>`;
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
