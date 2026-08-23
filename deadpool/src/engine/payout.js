/**
 * What a pool this size is actually worth, and what one entry is worth in it.
 *
 * A port of the reporting half of models/payout.py. The settling machinery —
 * `settle`, `pot_share` — stays in Python: it exists to terminate a simulation
 * over a whole field, and nothing in the browser has a field of 250 outcomes to
 * settle. What is here is the part a person reading their own screen needs.
 *
 * ── Why this file exists at all ─────────────────────────────────────────
 *
 * `poolSize`, `buyIn` and `terminalRule` had been in the stored state since the
 * first version, were carried through `poolRules()`, and were read by nothing.
 * `statusOf` and `headline` destructure `strikesAllowed` and `tieIsLoss` and
 * ignore the rest; no engine path touched them; there was no control to edit
 * them. The comment beside `poolSize` claimed it "decides how far you have to
 * get, which decides how much future value is worth" — a relationship that was
 * never implemented.
 *
 * A setting that silently does nothing is worse than an absent one, because it
 * reads as a knob somebody has already turned on your behalf. So either they
 * become real or they come out. These are the two things they can honestly
 * drive today:
 *
 *   1. **The pot, and what a fair share of it is.** Arithmetic, exact, and the
 *      denominator every rating on the settings screen is quoted against.
 *   2. **The assumed size of the field**, when no pool sheet is configured.
 *      `engine/field.js` knows the real number when a sheet is in hand; when
 *      it is not, this is the only statement anywhere about how many people
 *      you are up against.
 *
 * What they still do *not* drive is the strategy ratings. Those come from one
 * backtest run at 250 entries, and no amount of arithmetic here can restate a
 * measurement made at a different field size — see `ratingCaveat` below, which
 * says so on screen rather than letting the number imply otherwise.
 */

export const DEFAULT_POOL_SIZE = 250;
export const DEFAULT_BUY_IN = 10;
export const FINAL_WEEK = 18;

/** Historical public survival rate, per week. Describes the pool; never scores a pick. */
export const PUBLIC_WEEKLY_SURVIVAL = 0.73;

/** The whole pot. */
export const potOf = (poolSize = DEFAULT_POOL_SIZE, buyIn = DEFAULT_BUY_IN) =>
  Math.max(0, poolSize) * Math.max(0, buyIn);

/**
 * What one entry is worth playing at random — the number to beat.
 *
 * A share of 1/250 on a $10 buy-in is exactly $10 back on $10 staked. Every
 * rating in `measured.js` is a multiple of this, which is why it is worth
 * showing: `1.72x fair` means nothing until you know what fair is.
 */
export const fairShare = (poolSize = DEFAULT_POOL_SIZE) =>
  (poolSize > 0 ? 1 / poolSize : 0);

/** A pot share in money. */
export const valueOf = (share, poolSize = DEFAULT_POOL_SIZE, buyIn = DEFAULT_BUY_IN) =>
  share * potOf(poolSize, buyIn);

/**
 * How many entries a pool this size should expect to finish unbeaten.
 *
 * Below 1 is the regime where deepest-splits is not an edge case but the
 * normal ending — at 250 entries and the public rate it comes out at 0.87, and
 * that is the fact that makes a second entry worth having at all. It rises
 * fast with pool size, which is why this is worth showing beside the setting
 * rather than left as a constant in a Python file: at 1,000 entries it is 3.5,
 * and a season that ends with three perfect entries pays a third as much.
 */
export const expectedPerfectEntries = (
  poolSize = DEFAULT_POOL_SIZE,
  weeklySurvival = PUBLIC_WEEKLY_SURVIVAL,
  weeks = FINAL_WEEK,
) => Math.max(0, poolSize) * (weeklySurvival ** weeks);

/**
 * Whether the published ratings were measured at the pool you are actually in,
 * and what to say when they were not.
 *
 * `null` when the sizes match, so the caller renders nothing. The threshold is
 * a factor of two rather than exact equality: the ratings are a coarse
 * ordering of six strategies and a pool of 240 against 250 does not change it,
 * while 25 against 250 changes which strategy is right — the README's own
 * finding is that the field size "is the whole of how to use it, and it
 * reverses the answer".
 */
export function ratingCaveat(poolSize, measuredAt = DEFAULT_POOL_SIZE) {
  if (!Number.isFinite(poolSize) || poolSize <= 0) return null;
  const ratio = poolSize > measuredAt ? poolSize / measuredAt : measuredAt / poolSize;
  if (ratio < 2) return null;
  return poolSize < measuredAt
    ? `Your pool is ${poolSize}, and these were measured against ${measuredAt}. In a pool this `
      + 'small a second entry is worth less and playing the chalk costs less, so read the '
      + 'ordering as indicative rather than as measured for you.'
    : `Your pool is ${poolSize}, and these were measured against ${measuredAt}. In a pool this `
      + 'large surviving with the crowd is worth even less than these numbers say, so the gap '
      + 'between the top three and the bottom three is if anything understated.';
}
