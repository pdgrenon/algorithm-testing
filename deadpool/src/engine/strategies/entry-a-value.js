/**
 * Win probability, discounted by what the team is worth later.
 *
 * Port of `strategy/entry_a_value.py`, unchanged.
 *
 *     score = winPct * (1 - futureValuePenalty)
 *
 * The penalty is how much a team is marked down this week because a materially
 * better matchup is projected in the next few weeks — so a big favourite with
 * an even bigger mismatch coming in a week or two can rank behind a smaller,
 * use-it-now favourite. It is capped, so a distant hypothetical can never
 * fully override a strong matchup in hand.
 *
 * ── The part that has never run ─────────────────────────────────────────
 *
 * This strategy is only itself when it is given a schedule that extends past
 * the current week. In the Python CLI it never was: `main.py` does not import
 * this module at all, and even wired up it would have been fed a table built
 * from one week of games, leaving `remainingSchedule` empty, `futureValue`
 * null and the penalty flat zero — at which point it is `recommender.js` with
 * extra steps. The tests pass because they hand it a multi-week table by hand.
 *
 * The engine gets the real thing because ctx.schedule comes from the edge
 * Function's /api/season route. Nothing here changed to make that true.
 */

import { buildOptions, notUsed, byScoreDesc } from '../constraints.js';
import { computeFutureValue, DEFAULT_DECAY_RATE, DEFAULT_LOOKAHEAD_WEEKS } from '../future-value.js';
import { basisPhrase, remainingScheduleFor } from '../win-prob.js';
import { f1, pct0 } from '../fmt.js';
import { findConflicts } from './recommender.js';

export const ID = 'value';

// A futureValue of this many win-probability points (or more) maps to the full
// cap below: with the defaults, a future matchup 40 points better after decay
// caps the discount at 35%.
export const FUTURE_VALUE_PENALTY_SCALE = 40.0;
export const MAX_FUTURE_VALUE_PENALTY = 0.35;

/**
 * A futureValue in win-percentage points → a capped 0–1 penalty.
 *
 * Only a positive futureValue produces a penalty. There is deliberately no
 * bonus for a team with nothing better coming: the question this asks is
 * "should I wait", and "no" is not a reason to prefer them.
 */
export function futureValueToPenalty(futureValue) {
  if (futureValue === null || futureValue === undefined || futureValue <= 0) return 0.0;
  return Math.min(MAX_FUTURE_VALUE_PENALTY, futureValue / FUTURE_VALUE_PENALTY_SCALE);
}

/**
 * Rank this week's not-yet-used teams by the discounted score.
 *
 * `winProbTable` spans the season and supplies the future matchups; this
 * week's own probability comes from the game in hand rather than from a
 * lookup, which may be a stale cached copy of it.
 */
export function rankAvailableTeams(
  games,
  winProbTable,
  usedTeams,
  currentWeek,
  lookaheadWeeks = DEFAULT_LOOKAHEAD_WEEKS,
  decayRate = DEFAULT_DECAY_RATE,
) {
  const ranked = notUsed(buildOptions(games), usedTeams).map((o) => {
    const remaining = remainingScheduleFor(winProbTable, o.teamAbbreviation, currentWeek);
    const future = computeFutureValue(
      o.teamAbbreviation, currentWeek, o.winPct, remaining, lookaheadWeeks, decayRate,
    );
    const penalty = futureValueToPenalty(future.futureValue);
    return {
      teamAbbreviation: o.teamAbbreviation,
      teamName: o.teamName,
      opponentAbbreviation: o.opponentAbbreviation,
      eventId: o.eventId,
      startDate: o.startDate,
      winPct: o.winPct,
      winPctSource: o.winPctSource,
      winPctIsEstimated: o.winPctSource === 'spread_estimate',
      spreadDetail: o.spreadDetail,
      futureValue: future.futureValue,
      futureValuePenalty: penalty,
      bestFutureWeek: future.bestFutureWeek,
      bestFutureWinPct: future.bestFutureWinPct,
      score: o.winPct === null || o.winPct === undefined ? null : o.winPct * (1 - penalty),
    };
  });
  return ranked.sort(byScoreDesc);
}

export function describePick(pick) {
  const winPct = pick.winPct === null || pick.winPct === undefined ? 'unknown' : `${f1(pick.winPct)}%`;
  const basis = basisPhrase(pick.winPctSource);
  const spread = pick.spreadDetail ? `, spread ${pick.spreadDetail}` : '';
  return `${pick.teamAbbreviation} vs ${pick.opponentAbbreviation || '?'} -- ${winPct} win prob${basis}${spread}`;
}

export function buildReasoning(top, alternatives) {
  const parts = [`Top pick: ${describePick(top)}.`];

  if (top.score === null || top.score === undefined) {
    parts.push('No win probability data was available for this pick; it was chosen by default ordering.');
  } else if (top.futureValuePenalty > 0) {
    parts.push(
      `A future-value penalty of ${pct0(top.futureValuePenalty)} was applied `
      + `(a projected future matchup is about ${f1(top.futureValue)} points better after decay), `
      + `but ${top.teamAbbreviation} still scored highest at ${f1(top.score)}.`,
    );
  } else {
    parts.push(
      `No upcoming matchup is projected to beat this week's, so there's little value in holding `
      + `${top.teamAbbreviation} back -- it scored ${f1(top.score)} with no penalty applied.`,
    );
  }

  if (alternatives.length) {
    const runnerUp = alternatives[0];
    const runnerScore = runnerUp.score === null || runnerUp.score === undefined ? 'unknown' : f1(runnerUp.score);
    const topScore = top.score === null || top.score === undefined ? 'unknown' : f1(top.score);
    parts.push(`Next best was ${describePick(runnerUp)}, scoring ${runnerScore} vs ${topScore}.`);
  }

  return parts.join(' ');
}

export function recommend(games, winProbTable, currentWeek, usedTeams, lookaheadWeeks = DEFAULT_LOOKAHEAD_WEEKS, decayRate = DEFAULT_DECAY_RATE) {
  const ranked = rankAvailableTeams(games, winProbTable, usedTeams, currentWeek, lookaheadWeeks, decayRate);

  if (!ranked.length) {
    return {
      week: currentWeek,
      pick: null,
      reasoning: 'No eligible teams available this week (all used, or no game data).',
      alternatives: [],
    };
  }

  const [top, ...alternatives] = ranked;
  return { week: currentWeek, pick: top, reasoning: buildReasoning(top, alternatives), alternatives };
}

/* ------------------------------------------------ the registry contract -- */

export default {
  id: ID,
  name: 'Value, with lookahead',
  blurb: 'Marks a team down when a better matchup for them is projected in the next few weeks, so a strong team is not spent early.',
  entries: 'single',
  params: [
    { key: 'lookaheadWeeks', label: 'Look ahead', type: 'int', default: DEFAULT_LOOKAHEAD_WEEKS, min: 1, max: 12, unit: 'weeks', help: 'How far forward a better matchup is worth waiting for.' },
    { key: 'decayRate', label: 'Weekly discount', type: 'float', default: DEFAULT_DECAY_RATE, min: 0.5, max: 1, step: 0.01, help: 'How much less a matchup counts per week of distance. 1.00 trusts a week-6 projection as much as next Sunday.' },
  ],

  run(ctx) {
    const lookahead = ctx.params.lookaheadWeeks ?? DEFAULT_LOOKAHEAD_WEEKS;
    const decay = ctx.params.decayRate ?? DEFAULT_DECAY_RATE;
    const perEntry = {};
    const picks = [];

    for (const entry of ctx.entries) {
      const r = recommend(ctx.games, ctx.schedule, ctx.week, ctx.usedTeams[entry.id] ?? [], lookahead, decay);
      perEntry[entry.id] = r.pick ? [r.pick, ...r.alternatives] : [];
      picks.push({
        entry: entry.id,
        candidate: r.pick,
        reasoning: r.reasoning,
        factors: r.pick ? factorsFor(r.pick, r.alternatives[0]) : [],
      });
    }

    const warnings = [];
    if (ctx.scheduleWeeks <= 1) {
      warnings.push({ level: 'warn', text: 'Only this week is loaded, so nothing is projected ahead and the lookahead is doing nothing. This ranks identically to win probability until the season schedule is available.' });
    }
    // Two entries reasoned about one at a time land on the same team, because
    // this is deterministic and they start the season with the same inventory.
    // The backtester measures it at 100% of weeks until one of them dies --
    // two entries in name only, and the one holding that cannot hedge
    // anything. `recommender.js` has always warned about this and the two
    // per-entry strategies beside it did not; sequence-dp.js now does, and its
    // comment named this file as the remaining gap.
    const conflict = findConflicts(perEntry);
    if (conflict) {
      warnings.push({
        level: 'warn',
        text: `Both entries' top pick is ${conflict}. One result would eliminate both — take the runner-up for one of them.`,
      });
    }

    return {
      strategyId: ID,
      picks,
      candidates: perEntry,
      considered: Object.values(perEntry).reduce((n, c) => n + c.length, 0),
      warnings,
    };
  },
};

/** The prose above, as something the interface can lay out. */
function factorsFor(pick, runnerUp) {
  const f = [
    {
      label: 'Win probability',
      value: pick.winPct === null ? null : `${f1(pick.winPct)}%`,
      weight: 1,
      note: pick.winPctIsEstimated ? 'Estimated from the spread — ESPN has not published a probability yet.' : 'From ESPN.',
    },
  ];
  if (pick.futureValuePenalty > 0) {
    f.push({
      label: 'Held-back penalty',
      value: `−${pct0(pick.futureValuePenalty)}`,
      weight: -1,
      note: `Week ${pick.bestFutureWeek} looks about ${f1(pick.futureValue)} points better after decay.`,
    });
  } else {
    f.push({ label: 'Held-back penalty', value: 'none', weight: 0, note: 'Nothing better is projected for them inside the window.' });
  }
  f.push({ label: 'Score', value: pick.score === null ? null : f1(pick.score), weight: 1 });
  if (runnerUp) {
    f.push({
      label: 'Beat',
      value: runnerUp.teamAbbreviation,
      weight: 0,
      note: runnerUp.score === null ? 'The runner-up could not be scored.' : `by ${f1(pick.score - runnerUp.score)} points.`,
    });
  }
  return f;
}
