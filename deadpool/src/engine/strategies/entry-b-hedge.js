/**
 * Entry B's hedge: diversify away from Entry A's game without getting reckless.
 *
 * Port of `strategy/entry_b_hedge.py`, unchanged.
 *
 * The lightweight, sequential companion to the joint optimizer. It treats
 * Entry A's pick as already fixed — however it was decided — then finds Entry
 * B's best team that
 *
 *   * is not from the same game as Entry A's pick, so one result can never
 *     eliminate both entries, and
 *   * clears a minimum win-probability floor, so B never chases
 *     diversification into an unsafe underdog.
 *
 * Among the survivors it simply takes the highest probability. There is no
 * future-value weighting here on purpose: B's whole job in this strategy is
 * this-week safety, not season-long value banking.
 *
 * The floor is relaxed rather than enforced when nothing clears it, and that
 * is called out in the reasoning. A week with no pick is worse than a week
 * with a nervous one, and a floor that silently produced nothing would be
 * discovered at 12:55 on a Sunday.
 */

import { buildOptions, notUsed, byWinPctDesc } from '../constraints.js';
import { f0, f1 } from '../fmt.js';
import { basisPhrase } from '../win-prob.js';
import { recommend as valueRecommend } from './entry-a-value.js';

export const ID = 'hedge';

// 0–100, matching winPct everywhere else.
export const DEFAULT_MIN_WIN_PROB_FLOOR = 65.0;

export const meetsWinProbFloor = (winPct, floor) =>
  winPct !== null && winPct !== undefined && winPct >= floor;

/** The event a team is playing in this week, or null. */
export function eventIdForTeam(games, teamAbbreviation) {
  for (const game of games) {
    if (game.home.abbreviation === teamAbbreviation || game.away.abbreviation === teamAbbreviation) {
      return game.eventId;
    }
  }
  return null;
}

function buildCandidates(games, usedTeams, excludeEventId) {
  const options = buildOptions(games).filter(
    // Entry A's game: picking either side of it would put both entries on one
    // result, which is the whole thing this strategy exists to avoid.
    (o) => !(excludeEventId !== null && excludeEventId !== undefined && o.eventId === excludeEventId),
  );
  return notUsed(options, usedTeams).map((o) => ({
    teamAbbreviation: o.teamAbbreviation,
    teamName: o.teamName,
    opponentAbbreviation: o.opponentAbbreviation,
    eventId: o.eventId,
    startDate: o.startDate,
    winPct: o.winPct,
    winPctSource: o.winPctSource,
    winPctIsEstimated: o.winPctSource === 'spread_estimate',
    spreadDetail: o.spreadDetail,
  }));
}

/**
 * Eligible candidates, best first, and whether the floor had to be relaxed.
 *
 * `floorRelaxed` is true only when candidates existed but none cleared —
 * an empty board is not a relaxed floor, it is an empty board.
 */
export function rankHedgeCandidates(games, usedTeams, excludeEventId = null, minWinProbFloor = DEFAULT_MIN_WIN_PROB_FLOOR) {
  const all = buildCandidates(games, usedTeams, excludeEventId).sort(byWinPctDesc);
  const aboveFloor = all.filter((c) => meetsWinProbFloor(c.winPct, minWinProbFloor));
  if (aboveFloor.length) return { candidates: aboveFloor, floorRelaxed: false };
  return { candidates: all, floorRelaxed: all.length > 0 };
}

export function describe(candidate) {
  const winPct = candidate.winPct === null || candidate.winPct === undefined ? 'unknown' : `${f1(candidate.winPct)}%`;
  const basis = basisPhrase(candidate.winPctSource);
  const spread = candidate.spreadDetail ? `, spread ${candidate.spreadDetail}` : '';
  return `${candidate.teamAbbreviation} vs ${candidate.opponentAbbreviation || '?'} -- ${winPct} win prob${basis}${spread}`;
}

export function recommend(games, currentWeek, usedTeams, entryAPickTeam = null, minWinProbFloor = DEFAULT_MIN_WIN_PROB_FLOOR) {
  const excludeEventId = entryAPickTeam ? eventIdForTeam(games, entryAPickTeam) : null;
  const { candidates, floorRelaxed } = rankHedgeCandidates(games, usedTeams, excludeEventId, minWinProbFloor);

  if (!candidates.length) {
    return {
      week: currentWeek,
      pick: null,
      reasoning: 'No eligible teams available this week (all used, or no game data).',
      alternatives: [],
      floorRelaxed: false,
    };
  }

  const [top, ...alternatives] = candidates;

  const parts = [`Top pick: ${describe(top)}.`];
  if (floorRelaxed) {
    parts.push(
      `No available team cleared the ${f0(minWinProbFloor)}% floor this week; `
      + 'used the safest option available rather than leave Entry B without a pick.',
    );
  } else {
    parts.push(`Clears the ${f0(minWinProbFloor)}% win-probability floor.`);
  }
  if (excludeEventId !== null && excludeEventId !== undefined) {
    parts.push(`Avoided Entry A's game (${entryAPickTeam}) entirely, so one result can't eliminate both entries.`);
  }
  if (alternatives.length) {
    parts.push(`Next best was ${describe(alternatives[0])}.`);
  }

  return { week: currentWeek, pick: top, reasoning: parts.join(' '), alternatives, floorRelaxed };
}

/* ------------------------------------------------ the registry contract -- */

/**
 * Entry A decided on value, Entry B hedged against it.
 *
 * This composition is what `entry_b_hedge.py`'s own docstring describes —
 * "treats Entry A's pick (however it was decided -- e.g. entry_a_value.py) as
 * already fixed" — and it was never wired to anything. Nothing new is computed
 * here: it calls the two ported modules in the order they were written for.
 */
export default {
  id: 'sequential',
  name: 'One safe pick, one hedged',
  blurb: 'Your first entry takes the best pick it can find. Your second takes the safest team '
    + 'from a different game, so no single result can knock both entries out at once.',
  entries: 'both',
  params: [
    { key: 'minWinProbFloorB', label: 'Entry B floor', type: 'percent', default: DEFAULT_MIN_WIN_PROB_FLOOR, min: 0, max: 99, help: 'How safe Entry B has to be before diversification is worth it. Relaxed, loudly, if nothing clears it.' },
    { key: 'lookaheadWeeks', label: 'Entry A looks ahead', type: 'int', default: 6, min: 1, max: 12, unit: 'weeks' },
  ],

  run(ctx) {
    const [a, b] = ctx.entries;
    const floor = ctx.params.minWinProbFloorB ?? DEFAULT_MIN_WIN_PROB_FLOOR;
    const lookahead = ctx.params.lookaheadWeeks ?? 6;

    const aResult = valueRecommend(ctx.games, ctx.schedule, ctx.week, ctx.usedTeams[a.id] ?? [], lookahead);
    const bResult = recommend(
      ctx.games, ctx.week, ctx.usedTeams[b.id] ?? [],
      aResult.pick ? aResult.pick.teamAbbreviation : null, floor,
    );

    const warnings = [];
    if (bResult.floorRelaxed) {
      warnings.push({ level: 'warn', text: `Nothing available to ${b.name} cleared the ${f0(floor)}% floor. The safest option was taken instead of leaving the entry without a pick.` });
    }
    if (aResult.pick && bResult.pick && aResult.pick.eventId === bResult.pick.eventId) {
      warnings.push({ level: 'danger', text: 'Both picks are in the same game — one result would eliminate both entries.' });
    }

    return {
      strategyId: 'sequential',
      picks: [
        { entry: a.id, candidate: aResult.pick, reasoning: aResult.reasoning, factors: aResult.pick ? [
          { label: 'Win probability', value: `${f1(aResult.pick.winPct)}%`, weight: 1, note: aResult.pick.winPctIsEstimated ? 'Estimated from the spread.' : 'From ESPN.' },
          { label: 'Score after lookahead', value: aResult.pick.score === null ? null : f1(aResult.pick.score), weight: 1 },
        ] : [] },
        { entry: b.id, candidate: bResult.pick, reasoning: bResult.reasoning, factors: bResult.pick ? [
          { label: 'Win probability', value: `${f1(bResult.pick.winPct)}%`, weight: 1, note: bResult.pick.winPctIsEstimated ? 'Estimated from the spread.' : 'From ESPN.' },
          { label: 'Floor', value: `${f0(floor)}%`, weight: 0, note: bResult.floorRelaxed ? 'Relaxed — nothing cleared it.' : 'Cleared.' },
          { label: 'Different game from ' + a.name, value: aResult.pick ? 'yes' : 'n/a', weight: 1, note: aResult.pick ? `${a.name} is on ${aResult.pick.teamAbbreviation}.` : `${a.name} has no pick to avoid.` },
        ] : [] },
      ],
      candidates: {
        [a.id]: aResult.pick ? [aResult.pick, ...aResult.alternatives] : [],
        [b.id]: bResult.pick ? [bResult.pick, ...bResult.alternatives] : [],
      },
      considered: (aResult.alternatives.length + 1) + (bResult.alternatives.length + 1),
      warnings,
    };
  },
};
