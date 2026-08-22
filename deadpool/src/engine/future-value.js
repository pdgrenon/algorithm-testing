/**
 * How much a team is worth holding back rather than using this week.
 *
 * Port of `models/future_value.py`, unchanged.
 *
 * A survivor pool is a resource-allocation problem: each team can be picked
 * once per entry, all season. Spending your strongest team in week 2 against a
 * bad opponent is a mistake if that same team has an even easier matchup in
 * week 7, because using them now forfeits that spot.
 *
 *     futureValue > 0   a better spot is likely coming; consider holding
 *     futureValue <= 0  this week is about as good as it gets; use them
 *
 * Weeks further out are discounted, and that is a discount on confidence
 * rather than a prediction that opponents get harder: a bye, an injury or a
 * team collapsing all become more likely the further ahead you look.
 *
 * ── Worth knowing before you trust a number out of here ──────────────────
 *
 * This is inert unless it is given a schedule that runs past the current week.
 * In the Python CLI it never was — `get_week_games` fetches one week, so
 * `remainingSchedule` came out empty, `futureValue` came out null, and the
 * strategy that reads it silently degenerated into "highest win probability".
 * The edge Function's /api/season route exists to fix exactly that, which is
 * why the app can use this and the terminal tool never could.
 */

export const DEFAULT_LOOKAHEAD_WEEKS = 6;
export const DEFAULT_DECAY_RATE = 0.85;   // per week beyond the current one

/**
 * Weight for a matchup `distance` weeks out (1 = next week).
 *
 * 1.0 at distance 1, decaying by `decayRate` per additional week, so the next
 * several weeks stay near full weight and it tails off smoothly — no cliff at
 * the edge of the window.
 */
export const weightForDistance = (distance, decayRate) => decayRate ** Math.max(0, distance - 1);

/**
 * Score how much better a team's best upcoming matchup is than using them now.
 *
 * `remainingSchedule` only needs entries after `currentWeek`; anything at or
 * before it, or past the lookahead window, is ignored. A missing win
 * probability — a bye, or data ESPN has not published — is skipped rather than
 * treated as zero, so a lack of data never looks like a bad matchup.
 */
export function computeFutureValue(
  teamAbbreviation,
  currentWeek,
  currentWeekWinPct,
  remainingSchedule,
  lookaheadWeeks = DEFAULT_LOOKAHEAD_WEEKS,
  decayRate = DEFAULT_DECAY_RATE,
) {
  const result = {
    teamAbbreviation,
    currentWeek,
    currentWeekWinPct,
    bestFutureWeek: null,
    bestFutureWinPct: null,
    bestFutureWeightedWinPct: null,
    futureValue: null,
    weeklyWeighted: [],
  };

  const horizonEnd = currentWeek + lookaheadWeeks;
  const candidates = remainingSchedule
    .filter((e) => e.week !== null && e.week !== undefined && e.week > currentWeek && e.week <= horizonEnd)
    // Stable, and by week only — matching Python's `sort(key=lambda e: e.week)`.
    // Two entries can never share a week for one team, so this is a total
    // order in practice, but the tie-break has to stay stable regardless
    // because it decides which of two equal weighted values wins below.
    .sort((a, b) => a.week - b.week);

  let bestWeighted = null;
  for (const entry of candidates) {
    const distance = entry.week - currentWeek;
    const weight = weightForDistance(distance, decayRate);
    const weighted = entry.winPct === null || entry.winPct === undefined ? null : entry.winPct * weight;
    result.weeklyWeighted.push([entry.week, weighted]);

    if (weighted === null) continue;
    // Strictly greater, so the earliest of two equal weeks wins — the same
    // first-past-the-post the Python has.
    if (bestWeighted === null || weighted > bestWeighted) {
      bestWeighted = weighted;
      result.bestFutureWeek = entry.week;
      result.bestFutureWinPct = entry.winPct;
      result.bestFutureWeightedWinPct = weighted;
    }
  }

  if (bestWeighted !== null && currentWeekWinPct !== null && currentWeekWinPct !== undefined) {
    result.futureValue = bestWeighted - currentWeekWinPct;
  }

  return result;
}

/** True when a discounted future matchup already beats this week's. */
export const shouldHold = (result) => result.futureValue !== null && result.futureValue > 0;
