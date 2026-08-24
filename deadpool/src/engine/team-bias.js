/**
 * Per-team, per-venue correction for where the market has been wrong before.
 *
 * The read half of `models/team_bias.py`. The *fitting* half is not ported and
 * should not be: it needs ten seasons of historical results, and a browser
 * refitting an empirical-Bayes model on page load would be both slow and a
 * second implementation to keep in step. The fit happens once, offline, in
 * `python3 scripts/calibrate.py team-bias --write`, which writes the table
 * twice — as JSON for the oracle and as `./team-bias-table.js` for here — from
 * one run, so the two cannot come from different samples.
 *
 * What is worth knowing before reading a number out of this: on the shipped
 * sample the per-team residuals are almost entirely sampling noise, the
 * empirical-Bayes shrinkage keeps about 1% of each one, and the largest
 * surviving adjustment in the whole table is 0.17 points. It ships off. The
 * Python module's docstring has the variance decomposition and the argument.
 */

import { TEAM_BIAS_TABLE } from './team-bias-table.js';

export { TEAM_BIAS_TABLE };

/** The table's key for a venue context. One spelling, defined once. */
export const venueKey = (isHome) => (isHome ? 'home' : 'away');

/**
 * One team's adjustment in one venue, in points of win probability.
 *
 * Zero for anything this does not recognise — no table, no team, a team not in
 * the table, a malformed entry. A correction sits on top of a model that works
 * without it, so every failure here has to be "no correction" rather than an
 * exception: a Week screen that will not render because a lookup missed would
 * be a far worse outcome than a pick that is a tenth of a point off.
 */
export function biasFor(table, team, isHome) {
  if (!table || !team) return 0;
  const contexts = table[team];
  if (!contexts) return 0;
  const value = Number(contexts[venueKey(isHome)]);
  return Number.isFinite(value) ? value : 0;
}
