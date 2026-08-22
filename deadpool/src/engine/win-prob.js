/**
 * Per-team, per-week win probabilities.
 *
 * Port of `survivor-picker/models/win_prob.py`. Behaviour is unchanged and
 * held to that by test/parity.test.js; the constants below are the same three
 * values, and moving one of them here without moving it there is what the
 * golden fixtures exist to catch.
 *
 * Two sources are normalised into one shape: ESPN's own probability field when
 * they have published one, and an estimate derived from the betting spread
 * when they have not. `source` records which, and it is not decoration — the
 * two are different epistemic states and the interface marks an estimate every
 * time it draws one.
 */

// ESPN's probabilities endpoint is fractional (0–1); everything in this module
// deals in whole percentage points instead.
export const PERCENT_SCALE = 100.0;

// Rough rule of thumb: ~1 point of spread is worth ~1.2 points of win
// probability around a 50% baseline. Only used when ESPN has published nothing
// — the real value always wins.
export const SPREAD_POINTS_TO_WIN_PCT = 1.2;
export const MIN_WIN_PCT = 1.0;
export const MAX_WIN_PCT = 99.0;

/**
 * Fallback win probability from the betting spread, on a 0–100 scale.
 *
 * ESPN's `spread` is signed relative to the home team, so a negative number
 * means the home side is favoured — which is why this negates before doing
 * anything else. Reading the sign the other way produces a confident,
 * well-formatted recommendation for every underdog on the board.
 */
export function estimateWinPctFromSpread(spread, teamIsHome) {
  if (spread === null || spread === undefined) return null;
  const homeFavouredBy = -spread;
  const teamFavouredBy = teamIsHome ? homeFavouredBy : -homeFavouredBy;
  const estimate = 50.0 + teamFavouredBy * SPREAD_POINTS_TO_WIN_PCT;
  return Math.max(MIN_WIN_PCT, Math.min(MAX_WIN_PCT, estimate));
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
