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

/* ------------------------------------------------------------- de-vig -- */

/**
 * Port of the de-vig block in models/win_prob.py. The reasoning for the
 * default and the measured size of the disagreement live there and in
 * scripts/calibrate.py; this is the arithmetic only.
 *
 * Measured on 2,613 priced games, 2015–2024: on favourites above 85% the
 * multiplicative method reads 1.95 points lower than power, and that is
 * exactly where survivor picks live.
 */
export const DEVIG_METHODS = ['power', 'multiplicative', 'additive'];
export const DEFAULT_DEVIG_METHOD = 'power';

const POWER_K_LO = 0.2;
const POWER_K_HI = 8.0;
const POWER_ITERATIONS = 60;

/** NFL ties, measured: 15 in 6,967 regular season games, 1999–2025. */
export const TIE_PROBABILITY = 0.00215;

/** Confirmed for this pool. Note it is the opposite of the usual assumption. */
export const DEFAULT_TIE_IS_LOSS = false;

export const SHRINK_FREE_WEEKS = 4;
export const DEFAULT_SHRINK_TAU = 6.0;
export const SHRINK_PRIOR_PCT = 50.0;

/**
 * Solve q_home^k + q_away^k = 1 by bisection.
 *
 * A fixed iteration count rather than a tolerance loop, because this runs in
 * two languages and has to return the same bits: an early exit could take a
 * different number of steps under a last-ulp difference in `pow`.
 */
function bisectPowerK(homeRaw, awayRaw) {
  let lo = POWER_K_LO;
  let hi = POWER_K_HI;
  for (let i = 0; i < POWER_ITERATIONS; i += 1) {
    const mid = (lo + hi) / 2.0;
    if (homeRaw ** mid + awayRaw ** mid > 1.0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2.0;
}

/** Two raw implied probabilities into a pair summing to 1, conditional on no tie. */
export function devig(homeRaw, awayRaw, method = DEFAULT_DEVIG_METHOD) {
  if (!DEVIG_METHODS.includes(method)) {
    throw new Error(`devig method must be one of ${DEVIG_METHODS}, got ${method}`);
  }
  const total = homeRaw + awayRaw;
  if (total <= 0) throw new Error('cannot de-vig a pair of non-positive prices');

  if (method === 'multiplicative') return [homeRaw / total, awayRaw / total];

  if (method === 'additive') {
    const excess = (total - 1.0) / 2.0;
    const home = Math.max(0.0, homeRaw - excess);
    const away = Math.max(0.0, awayRaw - excess);
    const adjusted = home + away;
    if (adjusted <= 0) return [0.5, 0.5];
    return [home / adjusted, away / adjusted];
  }

  const k = bisectPowerK(homeRaw, awayRaw);
  const home = homeRaw ** k;
  const away = awayRaw ** k;
  const adjusted = home + away;
  return [home / adjusted, away / adjusted];
}

/**
 * A conditional-on-no-tie win share into the probability of *advancing*.
 *
 *     P(win)     = share * (1 - P(tie))
 *     P(advance) = P(win)            if a tie eliminates you
 *                = P(win) + P(tie)   if it does not
 *
 * Both branches exist because the answer flips with the pool's rules. In this
 * pool a tie is not a loss, so P(advance) is 1 - P(opponent wins) — which is
 * the reverse of what most survivor writing assumes.
 */
export function advanceProbability(winShare, tieIsLoss, tieProbability = TIE_PROBABILITY) {
  const pWin = winShare * (1.0 - tieProbability);
  return tieIsLoss ? pWin : pWin + tieProbability;
}

/**
 * Pull a projected win probability toward an even game with distance.
 *
 * The free window in front of the decay is measured, not assumed: accuracy
 * holds flat about four weeks out and degrades from five. See the Python
 * module for the numbers.
 */
export function shrinkTowardPrior(
  winPct, weeksAhead, tau = DEFAULT_SHRINK_TAU,
  priorPct = SHRINK_PRIOR_PCT, freeWeeks = SHRINK_FREE_WEEKS,
) {
  if (winPct === null || winPct === undefined) return null;
  if (weeksAhead <= freeWeeks) return winPct;
  const lam = Math.exp(-(weeksAhead - freeWeeks) / tau);
  return priorPct + lam * (winPct - priorPct);
}

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
export function winPctFromMoneylines(
  homeMoneyline, awayMoneyline, teamIsHome,
  method = DEFAULT_DEVIG_METHOD, tieIsLoss = DEFAULT_TIE_IS_LOSS,
) {
  const homeRaw = impliedProbFromMoneyline(homeMoneyline);
  const awayRaw = impliedProbFromMoneyline(awayMoneyline);
  if (homeRaw === null || awayRaw === null) return null;
  if (homeRaw + awayRaw <= 0) return null;

  const [homeShare, awayShare] = devig(homeRaw, awayRaw, method);
  const share = teamIsHome ? homeShare : awayShare;
  const advancing = advanceProbability(share, tieIsLoss);
  return Math.max(MIN_WIN_PCT, Math.min(MAX_WIN_PCT, advancing * PERCENT_SCALE));
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
export function estimateWinPctFromSpread(spread, teamIsHome, tieIsLoss = DEFAULT_TIE_IS_LOSS) {
  if (spread === null || spread === undefined) return null;
  const homeFavouredBy = -spread;
  const z = SPREAD_LOGISTIC_INTERCEPT + SPREAD_LOGISTIC_SLOPE * homeFavouredBy;
  const homeShare = 1.0 / (1.0 + Math.exp(-z));
  // Fitted on completed non-tie games, so like a two-way price it is already
  // conditional on no tie and takes the same last step.
  const share = teamIsHome ? homeShare : 1.0 - homeShare;
  const advancing = advanceProbability(share, tieIsLoss);
  return Math.max(MIN_WIN_PCT, Math.min(MAX_WIN_PCT, advancing * PERCENT_SCALE));
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
export function resolveTeamWinProbability(
  game, teamIsHome, tieIsLoss = DEFAULT_TIE_IS_LOSS, devigMethod = DEFAULT_DEVIG_METHOD,
) {
  const team = teamIsHome ? game.home : game.away;
  const opponent = teamIsHome ? game.away : game.home;

  let winPct = null;
  let source = 'unknown';

  const prob = game.probability;
  if (prob) {
    const raw = teamIsHome ? prob.homeWinPct : prob.awayWinPct;
    if (raw !== null && raw !== undefined) {
      // ESPN publishes a three-way split, so unlike a two-way price this is
      // already unconditional. The tie is *added*, not multiplied out.
      const advancing = tieIsLoss ? raw : raw + (prob.tiePct ?? 0);
      winPct = Math.max(MIN_WIN_PCT, Math.min(MAX_WIN_PCT, advancing * PERCENT_SCALE));
      source = 'api';
    }
  }

  if (winPct === null && game.odds) {
    const market = winPctFromMoneylines(
      game.odds.homeMoneyline, game.odds.awayMoneyline, teamIsHome, devigMethod, tieIsLoss,
    );
    if (market !== null) {
      winPct = market;
      source = 'moneyline';
    }
  }

  if (winPct === null) {
    const spread = game.odds ? game.odds.spread : null;
    const estimate = estimateWinPctFromSpread(spread, teamIsHome, tieIsLoss);
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
