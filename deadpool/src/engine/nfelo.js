/**
 * nfelo's CSV into the table `win-prob.js` blends against.
 *
 * The counterpart of `nflverse.js`: a second flat file from GitHub, parsed at
 * the edge so the phone never fetches 1.4 MB to read one season out of it.
 * The arithmetic — which column, which id format, which team abbreviations —
 * lives in `elo.js` alongside its Python twin; this is the CSV handling and
 * the season filter, and nothing else.
 *
 * Filtered by season on purpose. The whole file is every game since 2009,
 * where the app only ever asks about the season it is showing, and the
 * difference is about 4,600 rows against 270.
 */

import { splitCsvLine } from './nflverse.js';
import { parseNfeloRows } from './elo.js';

/**
 * One season's `{ gameId: homeWinProbability }` from the raw CSV.
 *
 * Returns `{}` for a season the file does not cover, an unparseable file, or a
 * missing probability column — never throws. A game absent from the result
 * falls back to the market, which is the correct behaviour for the ordinary
 * case: nfelo publishes ratings as the week arrives, so most of a lookahead
 * horizon is legitimately not in here yet.
 */
export function parseNfeloSeason(csv, season) {
  const lines = (csv || '').split('\n');
  if (lines.length < 2) return {};

  const header = splitCsvLine(lines[0]);
  const idColumn = header.indexOf('game_id');
  const probabilityColumn = header.indexOf('nfelo_home_probability_close');
  if (idColumn < 0 || probabilityColumn < 0) return {};

  // Every id starts with the season, so a cheap prefix test skips the ~95% of
  // rows that cannot match before paying for a full split.
  const prefix = `${Number(season)}_`;
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.includes(prefix)) continue;
    const fields = splitCsvLine(line);
    const gameId = fields[idColumn];
    if (!gameId || !gameId.startsWith(prefix)) continue;
    rows.push({
      game_id: gameId,
      nfelo_home_probability_close: fields[probabilityColumn],
    });
  }
  return parseNfeloRows(rows);
}
