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

import {
  DEFAULT_DEVIG_METHOD, DEVIG_METHODS,
  SPREAD_LOGISTIC_INTERCEPT, SPREAD_LOGISTIC_SLOPE,
  devig, homeShareFromSpreadLine, impliedProbFromMoneyline, spreadLineFromHomeShare,
} from './market-curve.js';
import { DEFAULT_MARKET_WEIGHT, compareModels, homeWinShare as eloHomeWinShare } from './elo.js';
import { biasFor } from './team-bias.js';

// The price-to-probability primitives — the de-vig, the fitted spread curve and
// its inverse — live in market-curve.js, with the calibration evidence for
// each. Re-exported here so that `import { devig } from './win-prob.js'`, which
// four strategies and the suite do, keeps resolving, and so this module still
// reads as the one place a win probability comes from.
export {
  DEFAULT_DEVIG_METHOD, DEVIG_METHODS,
  SPREAD_LOGISTIC_INTERCEPT, SPREAD_LOGISTIC_SLOPE,
  devig, homeShareFromSpreadLine, impliedProbFromMoneyline, spreadLineFromHomeShare,
};

// ESPN's probabilities endpoint is fractional (0–1); everything in this module
// deals in whole percentage points instead.
export const PERCENT_SCALE = 100.0;

export const MIN_WIN_PCT = 1.0;
export const MAX_WIN_PCT = 99.0;

/** NFL ties, measured: 15 in 6,967 regular season games, 1999–2025. */
export const TIE_PROBABILITY = 0.00215;

/** Confirmed for this pool. Note it is the opposite of the usual assumption. */
export const DEFAULT_TIE_IS_LOSS = false;

export const SHRINK_FREE_WEEKS = 4;
export const DEFAULT_SHRINK_TAU = 6.0;
export const SHRINK_PRIOR_PCT = 50.0;

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
  const homeShare = homeShareFromSpreadLine(-spread);
  // Fitted on completed non-tie games, so like a two-way price it is already
  // conditional on no tie and takes the same last step.
  const share = teamIsHome ? homeShare : 1.0 - homeShare;
  const advancing = advanceProbability(share, tieIsLoss);
  return Math.max(MIN_WIN_PCT, Math.min(MAX_WIN_PCT, advancing * PERCENT_SCALE));
}

/**
 * The game's market-implied **home** win share, conditional on no tie.
 *
 * The same three rungs as `resolveTeamWinProbability`, in the same order, but
 * stopping one step earlier — before the tie is folded in and before the 0–100
 * scaling. That is the scale a second model can be compared with, so it is
 * what the Elo blend and the divergence are computed on.
 *
 * Always the home side's, never the requested team's: one game, one number.
 */
export function marketHomeShare(game, devigMethod = DEFAULT_DEVIG_METHOD) {
  const prob = game.probability;
  if (prob
    && prob.homeWinPct !== null && prob.homeWinPct !== undefined
    && prob.awayWinPct !== null && prob.awayWinPct !== undefined) {
    // ESPN's split is three-way and unconditional, so renormalising the two
    // win outcomes against each other is what removes the tie and puts this on
    // the same footing as a two-way price.
    const total = prob.homeWinPct + prob.awayWinPct;
    if (total > 0) return prob.homeWinPct / total;
  }

  if (game.odds) {
    const homeRaw = impliedProbFromMoneyline(game.odds.homeMoneyline);
    const awayRaw = impliedProbFromMoneyline(game.odds.awayMoneyline);
    if (homeRaw !== null && awayRaw !== null && homeRaw + awayRaw > 0) {
      return devig(homeRaw, awayRaw, devigMethod)[0];
    }
    if (game.odds.spread !== null && game.odds.spread !== undefined) {
      // ESPN's spread is negative when the home side is favoured.
      return homeShareFromSpreadLine(-game.odds.spread);
    }
  }

  return null;
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

/**
 * Normalised win probability for one side of one game.
 *
 * `opts` carries the two optional corrections — `{ eloTable, marketWeight,
 * biasTable }` — and both are off when omitted. With both omitted this returns
 * exactly what it returned before either existed, bit for bit, which is what
 * keeps every number in engine/measured.js attached to the code that produced
 * it. See `resolve_team_win_probability` in models/win_prob.py for the full
 * argument, including why both corrections are applied as an additive delta to
 * the finished percentage rather than by re-deriving it, and why both are
 * scaled by `(1 - TIE_PROBABILITY)`.
 */
export function resolveTeamWinProbability(
  game, teamIsHome, tieIsLoss = DEFAULT_TIE_IS_LOSS, devigMethod = DEFAULT_DEVIG_METHOD,
  opts = {},
) {
  const { eloTable = null, marketWeight = DEFAULT_MARKET_WEIGHT, biasTable = null } = opts;
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

  const marketWinPct = winPct;
  let marketSpread = null;
  let eloSpread = null;
  let divergence = null;
  let teamBiasPct = 0;

  const homeShare = marketHomeShare(game, devigMethod);
  if (homeShare !== null) {
    const eloHomeShare = eloHomeWinShare(
      eloTable, game.seasonYear, game.week,
      game.away.abbreviation, game.home.abbreviation,
    );
    const comparison = compareModels(homeShare, eloHomeShare, marketWeight);
    marketSpread = comparison.marketSpread;
    eloSpread = comparison.eloSpread;
    divergence = comparison.divergence;

    if (winPct !== null && comparison.blended && eloHomeShare !== null) {
      // The blend moves the *home* share; the away side moves by the same
      // amount in the opposite direction, which keeps a game's two rows
      // summing the way they did before.
      let delta = comparison.blendedHomeShare - homeShare;
      if (!teamIsHome) delta = -delta;
      winPct = Math.max(MIN_WIN_PCT, Math.min(
        MAX_WIN_PCT, winPct + delta * (1.0 - TIE_PROBABILITY) * PERCENT_SCALE,
      ));
    }
  }

  if (biasTable && winPct !== null) {
    teamBiasPct = biasFor(biasTable, team.abbreviation, teamIsHome);
    if (teamBiasPct) {
      winPct = Math.max(MIN_WIN_PCT, Math.min(
        MAX_WIN_PCT, winPct + teamBiasPct * (1.0 - TIE_PROBABILITY),
      ));
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
    // The model's own working, for a surface that wants to show it. All five
    // are "nothing was applied" by default — see the Python twin.
    marketWinPct,
    marketSpread,
    eloSpread,
    divergence,
    teamBiasPct,
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
export function buildWinProbabilityTable(games, opts = {}) {
  const table = new Map();
  for (const game of games) {
    if (game.week === null || game.week === undefined) continue;
    for (const [team, isHome] of [[game.home, true], [game.away, false]]) {
      if (!team.abbreviation) continue;
      table.set(key(team.abbreviation, game.week), resolveTeamWinProbability(
        game, isHome, DEFAULT_TIE_IS_LOSS, DEFAULT_DEVIG_METHOD, opts,
      ));
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
