/**
 * Per-team, per-week win probabilities.
 *
 * Port of `models/win_prob.py`. Behaviour is identical and held to that by
 * test/parity.test.js; the constants below are the same values, and moving one
 * of them here without moving it there is what the golden fixtures exist to
 * catch.
 *
 * Three sources are normalised into one shape, in this order: ESPN's own
 * probability field, then the de-vigged moneyline pair, then an estimate
 * derived from the betting spread. `source` records which, and it is not
 * decoration — they are different epistemic states and the interface says
 * which one it is drawing every time.
 *
 * Note that a moneyline is *not* an estimate in this project's sense. The
 * amber treatment means "this number came out of a rule of thumb"; a
 * moneyline came out of a market. Only `spread_estimate` is amber.
 *
 * The reasoning for the ordering and for the de-vig is written out in the
 * Python module's docstring rather than duplicated here — one explanation,
 * and the port carries a pointer to it.
 */

// ESPN's probabilities endpoint is fractional (0–1); everything in this module
// deals in whole percentage points instead.
export const PERCENT_SCALE = 100.0;

// Spread → win probability, as a logistic fitted to actual results: 3,018
// completed non-tie games with a posted line, nflverse seasons 2015–2025, fitted
// by Newton-Raphson offline. This replaced `50 + spread * 1.2`, which scored a
// 14-point favourite at 66.4% where such teams actually win 93.0%.
//
// Written down rather than fitted at run time because nothing in the suite may
// touch the network. Keep these two in lockstep with models/win_prob.py.
export const SPREAD_LOGISTIC_INTERCEPT = -0.0423;
export const SPREAD_LOGISTIC_SLOPE = 0.1467;

export const MIN_WIN_PCT = 1.0;
export const MAX_WIN_PCT = 99.0;

/** One American moneyline as its raw, vig-included implied probability (0–1). */
export function impliedProbFromMoneyline(moneyline) {
  if (moneyline === null || moneyline === undefined || moneyline === 0) return null;
  if (moneyline > 0) return 100.0 / (moneyline + 100.0);
  return -moneyline / (-moneyline + 100.0);
}

/**
 * De-vigged win probability for one side, on a 0–100 scale.
 *
 * Needs *both* prices. One side alone carries the book's margin with no way to
 * separate it out, and using it raw would read a 4–5 point overround as
 * genuine confidence.
 */
export function winPctFromMoneylines(homeMoneyline, awayMoneyline, teamIsHome) {
  const homeRaw = impliedProbFromMoneyline(homeMoneyline);
  const awayRaw = impliedProbFromMoneyline(awayMoneyline);
  if (homeRaw === null || awayRaw === null) return null;

  const total = homeRaw + awayRaw;
  if (total <= 0) return null;

  const share = (teamIsHome ? homeRaw : awayRaw) / total;
  return Math.max(MIN_WIN_PCT, Math.min(MAX_WIN_PCT, share * PERCENT_SCALE));
}

/**
 * Fallback win probability from the betting spread, on a 0–100 scale.
 *
 * ESPN's `spread` is signed relative to the home team, so a negative number
 * means the home side is favoured — which is why this negates before doing
 * anything else. Reading the sign the other way produces a confident,
 * well-formatted recommendation for every underdog on the board.
 *
 * The curve is solved for the home side and the away side is its complement,
 * rather than solving it twice with a flipped sign: the intercept is a small
 * home-field residual and must not change sign with the team being asked
 * about. It also keeps the mirror exact — a home side at 71.3% leaves the away
 * side at 28.7%.
 */
export function estimateWinPctFromSpread(spread, teamIsHome) {
  if (spread === null || spread === undefined) return null;
  const homeFavouredBy = -spread;
  const z = SPREAD_LOGISTIC_INTERCEPT + SPREAD_LOGISTIC_SLOPE * homeFavouredBy;
  const homePct = PERCENT_SCALE / (1.0 + Math.exp(-z));
  const estimate = teamIsHome ? homePct : PERCENT_SCALE - homePct;
  return Math.max(MIN_WIN_PCT, Math.min(MAX_WIN_PCT, estimate));
}

/**
 * The parenthetical a surface adds after a percentage to name its source.
 *
 * Defined once because several surfaces draw it, and a surface that forgot a
 * new source would silently present a market price as ESPN's own model. Port
 * of `basis_phrase` in models/win_prob.py; parity compares these strings
 * exactly, so the two wordings have to stay identical.
 */
export function basisPhrase(source) {
  if (source === 'spread_estimate') return ' (estimated from spread)';
  if (source === 'moneyline') return ' (de-vigged moneyline)';
  return '';
}

/** Normalised win probability for one side of one game. */
export function resolveTeamWinProbability(game, teamIsHome) {
  const team = teamIsHome ? game.home : game.away;
  const opponent = teamIsHome ? game.away : game.home;

  let winPct = null;
  let source = 'unknown';

  const prob = game.probability;
  if (prob) {
    const raw = teamIsHome ? prob.homeWinPct : prob.awayWinPct;
    if (raw !== null && raw !== undefined) {
      winPct = raw * PERCENT_SCALE;
      source = 'api';
    }
  }

  if (winPct === null && game.odds) {
    const market = winPctFromMoneylines(
      game.odds.homeMoneyline, game.odds.awayMoneyline, teamIsHome,
    );
    if (market !== null) {
      winPct = market;
      source = 'moneyline';
    }
  }

  if (winPct === null) {
    const spread = game.odds ? game.odds.spread : null;
    const estimate = estimateWinPctFromSpread(spread, teamIsHome);
    if (estimate !== null) {
      winPct = estimate;
      source = 'spread_estimate';
    }
  }

  return {
    teamAbbreviation: team.abbreviation,
    week: game.week,
    seasonYear: game.seasonYear,
    opponentAbbreviation: opponent.abbreviation,
    isHome: teamIsHome,
    winPct,
    source,
  };
}

/**
 * Assemble a `Map` keyed `"ABBR|week"` spanning however many weeks are fed in.
 *
 * A Map rather than a plain object because insertion order has to be stable
 * and predictable: `remainingScheduleFor` below walks it in order, and while
 * the consumers sort by week afterwards, an unordered container would make
 * that a coincidence rather than a guarantee.
 *
 * A bye week simply produces no entry, which is the correct clean
 * representation for future-value: absent is not the same as bad.
 */
export function buildWinProbabilityTable(games) {
  const table = new Map();
  for (const game of games) {
    if (game.week === null || game.week === undefined) continue;
    for (const [team, isHome] of [[game.home, true], [game.away, false]]) {
      if (!team.abbreviation) continue;
      table.set(key(team.abbreviation, game.week), resolveTeamWinProbability(game, isHome));
    }
  }
  return table;
}

export const key = (abbreviation, week) => `${abbreviation}|${week}`;

/** Convenience lookup; null for a bye week or missing data. */
export function getTeamWinPct(table, teamAbbreviation, week) {
  const entry = table.get(key(teamAbbreviation, week));
  return entry ? entry.winPct : null;
}

/** Every entry for one team after `week`, in table order. */
export function remainingScheduleFor(table, teamAbbreviation, week) {
  const out = [];
  for (const [k, entry] of table) {
    const bar = k.lastIndexOf('|');
    if (k.slice(0, bar) !== teamAbbreviation) continue;
    if (Number(k.slice(bar + 1)) > week) out.push(entry);
  }
  return out;
}
