/**
 * A second opinion on every game, and what to do when it disagrees.
 *
 * Port of `models/elo.py`. Behaviour is identical and held to that by
 * test/parity.test.js; the reasoning — why the blend happens in spread points
 * rather than in probability, why the divergence is signed and fixed to the
 * home team, and why the blend ships off — is written out once, in the Python
 * module's docstring, and this carries a pointer to it rather than a copy.
 *
 * The one thing worth repeating here, because it is what the callers depend
 * on: at `marketWeight = 1` this returns the market share *unchanged and
 * un-round-tripped*, so wiring it in moved no existing number by a single bit.
 */

import { homeShareFromSpreadLine, spreadLineFromHomeShare } from './market-curve.js';

/** Market-only, and the default. See the Python docstring for why. */
export const DEFAULT_MARKET_WEIGHT = 1.0;

/** nfelo's home win probability column: the model's final pregame word. */
export const NFELO_HOME_PROBABILITY_COLUMN = 'nfelo_home_probability_close';

/** nfelo's game_id: SEASON_WW_AWAY_HOME, e.g. "2026_01_DAL_NYG". */
export const GAME_ID_PATTERN = /^(\d{4})_(\d{2})_([A-Z]+)_([A-Z]+)$/;

/**
 * This app's abbreviation → nfelo's.
 *
 * nfelo keeps one abbreviation per franchise across relocations where this app
 * uses ESPN's current-day one. All three that differ are teams that moved. A
 * missing entry does not throw — it produces a game nfelo never matches, which
 * falls back to market-only for that game and nowhere else, which is the
 * quietest way for this to be wrong.
 */
export const NFELO_ALIASES = {
  LV: 'OAK',    // Raiders — nfelo keeps the Oakland abbreviation
  LAR: 'LAR',   // Rams — same on both sides, listed so the set is visibly complete
  WSH: 'WAS',   // Commanders
};

/** One of this app's team abbreviations as nfelo spells it. */
export const nfeloTeam = (abbreviation) =>
  (abbreviation ? (NFELO_ALIASES[abbreviation] ?? abbreviation) : null);

/**
 * The nfelo key for one game, or null if it cannot be built.
 *
 * The week is zero-padded to two digits and the away team comes first. Both
 * are easy to get backwards and neither fails loudly — the lookup just misses.
 */
export function nfeloGameId(season, week, awayAbbreviation, homeAbbreviation) {
  const away = nfeloTeam(awayAbbreviation);
  const home = nfeloTeam(homeAbbreviation);
  if (season === null || season === undefined) return null;
  if (week === null || week === undefined) return null;
  if (!away || !home) return null;
  return `${Number(season)}_${String(Number(week)).padStart(2, '0')}_${away}_${home}`;
}

/**
 * nfelo's rows as `{ gameId: homeWinProbability }`.
 *
 * Rows with an unparseable id or a missing/out-of-range probability are
 * skipped rather than defaulted: a game absent from this table falls back to
 * the market, which is the right behaviour for a data lag and for a game the
 * model does not cover.
 */
export function parseNfeloRows(rows) {
  const table = {};
  for (const row of rows ?? []) {
    const gameId = row?.game_id;
    if (!gameId || !GAME_ID_PATTERN.test(String(gameId))) continue;
    const raw = row[NFELO_HOME_PROBABILITY_COLUMN];
    if (raw === null || raw === undefined || raw === '' || raw === 'NA') continue;
    const probability = Number(raw);
    if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) continue;
    table[String(gameId)] = probability;
  }
  return table;
}

/**
 * nfelo's home-team win share for one game, or null when it has no rating.
 *
 * Conditional on no tie, matching a two-way price — so it can be compared with
 * the market's on equal terms with no conversion step.
 */
export function homeWinShare(table, season, week, awayAbbreviation, homeAbbreviation) {
  if (!table) return null;
  const gameId = nfeloGameId(season, week, awayAbbreviation, homeAbbreviation);
  if (gameId === null) return null;
  const value = table[gameId];
  return value === undefined ? null : value;
}

/**
 * Put both models on the spread scale, blend there, and name the gap.
 *
 * Returns `{ marketSpread, eloSpread, divergence, blendedHomeShare, marketWeight, blended }`.
 * Every spread is in the home team's convention — positive means the home side
 * is favoured — whatever team is being evaluated.
 *
 * `marketWeight` is clamped rather than rejected: this sits behind a slider,
 * and a stored setting from an older build must not be able to stop the Week
 * screen rendering.
 */
export function compareModels(marketHomeShare, eloHomeShare, marketWeight = DEFAULT_MARKET_WEIGHT) {
  const weight = Math.min(1.0, Math.max(0.0, Number(marketWeight)));
  const marketSpread = spreadLineFromHomeShare(marketHomeShare);

  if (eloHomeShare === null || eloHomeShare === undefined) {
    return {
      marketSpread,
      eloSpread: null,
      divergence: null,
      blendedHomeShare: marketHomeShare,
      marketWeight: weight,
      blended: false,
    };
  }

  const eloSpread = spreadLineFromHomeShare(eloHomeShare);
  const divergence = eloSpread - marketSpread;

  // Deliberately the *original* share when the blend is off, rather than one
  // round-tripped through the logistic and back. The two agree to about 1e-16,
  // and "off" has to mean exactly the number the market gave — otherwise every
  // golden fixture moves the day this is wired in.
  const blendedHomeShare = weight >= 1.0
    ? marketHomeShare
    : homeShareFromSpreadLine(weight * marketSpread + (1.0 - weight) * eloSpread);

  return {
    marketSpread,
    eloSpread,
    divergence,
    blendedHomeShare,
    marketWeight: weight,
    blended: weight < 1.0,
  };
}
