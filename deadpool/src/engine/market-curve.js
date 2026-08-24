/**
 * Market prices into probabilities: the curve and the de-vig, alone.
 *
 * Port of `models/market_curve.py`, and it exists for the same reason that
 * file does. This is the layer underneath `win-prob.js`: the two ways a posted
 * price becomes a probability — de-vigging a moneyline pair, and the fitted
 * logistic on a spread — plus the logistic's inverse.
 *
 * Three modules need exactly this set and cannot all import each other.
 * `win-prob.js` reads `elo.js` to blend in a second model; `elo.js` needs the
 * curve to put an Elo probability on the market's scale. Importing back would
 * be a cycle. Everything here is arithmetic with no opinion about which source
 * wins, which is the natural place to cut.
 *
 * `win-prob.js` re-exports every name below, so an existing
 * `import { devig } from './win-prob.js'` still resolves and no caller changed.
 */

// Spread → win probability, as a logistic fitted to actual results: 3,018
// completed non-tie games with a posted line, nflverse seasons 2015–2025, fitted
// by Newton-Raphson offline. This replaced `50 + spread * 1.2`, which scores a
// game laid at fourteen points at 66.8% where the favourite won 88.1% of the 42
// such games; this curve scores it at 88.2%.
//
// Written down rather than fitted at run time because nothing in the suite may
// touch the network. Keep these two in lockstep with models/win_prob.py, which
// carries the held-out score and the calibration table's worst band.
export const SPREAD_LOGISTIC_INTERCEPT = -0.0423;
export const SPREAD_LOGISTIC_SLOPE = 0.1467;

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
 * The fitted logistic: points the home side is favoured by → its win share.
 *
 * `spreadLine` is in the **home-favoured-by** convention — positive means the
 * home team is laying points. ESPN's `spread` is the opposite way round and is
 * negated by its caller, not here.
 *
 * Port of `home_share_from_spread_line` in models/market_curve.py. There is
 * one copy of this curve on each side of the port and no more: a second one
 * that drifted by a hundredth would not fail a test, it would show up as a
 * measured edge for whichever strategy happened to read the newer spelling.
 */
export function homeShareFromSpreadLine(spreadLine) {
  const z = SPREAD_LOGISTIC_INTERCEPT + SPREAD_LOGISTIC_SLOPE * spreadLine;
  return 1.0 / (1.0 + Math.exp(-z));
}

/**
 * Inverse of `homeShareFromSpreadLine`: a win share back onto points.
 *
 * What puts a probability that never came from a spread — an Elo model's, say
 * — onto the same scale as a posted line. Clamped away from 0 and 1 first,
 * since the logit of either is infinite.
 */
export function spreadLineFromHomeShare(homeShare) {
  const p = Math.min(Math.max(Number(homeShare), 1e-9), 1.0 - 1e-9);
  return (Math.log(p / (1.0 - p)) - SPREAD_LOGISTIC_INTERCEPT) / SPREAD_LOGISTIC_SLOPE;
}

/** One American moneyline as its raw, vig-included implied probability (0–1). */
export function impliedProbFromMoneyline(moneyline) {
  if (moneyline === null || moneyline === undefined || moneyline === 0) return null;
  if (moneyline > 0) return 100.0 / (moneyline + 100.0);
  return -moneyline / (-moneyline + 100.0);
}
