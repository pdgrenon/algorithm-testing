/**
 * Both entries chosen together.
 *
 * Port of `strategy/joint_optimizer.py`, unchanged.
 *
 * Rather than fixing Entry A first and hedging B against it, this searches
 * every legal (teamA, teamB) pair and takes the one that maximises
 *
 *     P(A wins) + P(B wins) − P(A loses AND B loses)
 *
 * Independence between the two games is assumed, and — this is the part worth
 * keeping straight — it holds by construction rather than by hope: a pair is
 * only legal if the two teams come from different games, so there is never a
 * pair whose outcomes are perfectly anti-correlated because they are playing
 * each other.
 *
 * A pair is considered only if it
 *   * never repeats a team either entry has already used this season,
 *   * never gives both entries the same team,
 *   * never puts the two entries in the same game, and
 *   * keeps Entry B at or above its floor — unless nothing clears it, in which
 *     case the floor is relaxed and said out loud.
 *
 * The search space is at most about twice the number of games, squared, so
 * this is a plain scan over all pairs rather than a solver.
 */

import { buildOptions, sameGame, sameTeam, cmpStr, byWinPctDesc, boardBehind } from '../constraints.js';
import { f1, f0, f3 } from '../fmt.js';
import { basisPhrase } from '../win-prob.js';
import { DEFAULT_MIN_WIN_PROB_FLOOR, meetsWinProbFloor } from './entry-b-hedge.js';

export const ID = 'joint';
export { DEFAULT_MIN_WIN_PROB_FLOOR };

/** Every team playing a not-yet-started game, used teams included. */
export function buildTeamOptions(games) {
  return buildOptions(games).map((o) => ({
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

export function scorePair(a, b) {
  const pA = a.winPct / 100.0;
  const pB = b.winPct / 100.0;
  const bothSurvive = pA * pB;
  const bothEliminated = (1 - pA) * (1 - pB);
  const oneSurvives = 1.0 - bothSurvive - bothEliminated;
  return {
    pickA: a,
    pickB: b,
    bothSurvivePct: bothSurvive * 100.0,
    oneSurvivesPct: oneSurvives * 100.0,
    bothEliminatedPct: bothEliminated * 100.0,
    objectiveScore: pA + pB - bothEliminated,
  };
}

export function findBestPair(games, usedTeamsA, usedTeamsB, minWinProbFloorB = DEFAULT_MIN_WIN_PROB_FLOOR) {
  const options = buildTeamOptions(games);

  const hasProb = (o) => o.winPct !== null && o.winPct !== undefined;
  const availableA = options.filter((o) => !usedTeamsA.includes(o.teamAbbreviation) && hasProb(o));
  const availableBAll = options.filter((o) => !usedTeamsB.includes(o.teamAbbreviation) && hasProb(o));
  let availableB = availableBAll.filter((o) => meetsWinProbFloor(o.winPct, minWinProbFloorB));

  let floorRelaxed = false;
  if (!availableB.length && availableBAll.length) {
    availableB = availableBAll;
    floorRelaxed = true;
  }

  const scored = [];
  for (const a of availableA) {
    for (const b of availableB) {
      if (sameTeam(a, b)) continue;
      if (sameGame(a, b)) continue;   // opposing sides of one result
      scored.push(scorePair(a, b));
    }
  }

  // (-objective, teamA, teamB) — the abbreviation tie-breaks are not cosmetic.
  // A board where several pairs share an objective is common once
  // probabilities come from spreads, and without them the answer would depend
  // on the order ESPN happened to list the games.
  scored.sort((x, y) =>
    (y.objectiveScore - x.objectiveScore)
    || cmpStr(x.pickA.teamAbbreviation, y.pickA.teamAbbreviation)
    || cmpStr(x.pickB.teamAbbreviation, y.pickB.teamAbbreviation));

  const best = scored.length ? scored[0] : null;

  // The same two teams with A and B swapped scores identically — the objective
  // is symmetric — but is not a meaningfully different alternative. Step past
  // any such swap to find a genuinely different runner-up pairing.
  let runnerUp = null;
  if (best) {
    const bestSet = new Set([best.pickA.teamAbbreviation, best.pickB.teamAbbreviation]);
    for (const candidate of scored.slice(1)) {
      const set = new Set([candidate.pickA.teamAbbreviation, candidate.pickB.teamAbbreviation]);
      if (set.size !== bestSet.size || [...set].some((t) => !bestSet.has(t))) { runnerUp = candidate; break; }
    }
  }

  return { best, runnerUp, floorRelaxed, pairsConsidered: scored.length };
}

export function describe(option) {
  const winPct = option.winPct === null || option.winPct === undefined ? 'unknown' : `${f1(option.winPct)}%`;
  const basis = basisPhrase(option.winPctSource);
  const spread = option.spreadDetail ? `, spread ${option.spreadDetail}` : '';
  return `${option.teamAbbreviation} vs ${option.opponentAbbreviation || '?'} -- ${winPct} win prob${basis}${spread}`;
}

/**
 * A few sentences, shown per pick on a phone and in the CLI report.
 *
 * Port of `build_reasoning` in strategy/joint_optimizer.py, held to it
 * character for character by the parity suite and fixtures/golden.
 *
 * Three things were dropped because the screen already carried them, and
 * saying them twice is what made the panel a wall of text:
 *
 *   * the both-survive / one-survives / both-eliminated split, which the view
 *     renders as its own factor rows above this prose — see `odds` below.
 *   * "Entry B's pick clears the N% floor", which fired on every ordinary week
 *     and so told nobody anything. The interesting case is the floor being
 *     *relaxed*, which still says so and also raises a warning.
 *   * the objective scores behind the runner-up comparison. Which pairing won
 *     is worth knowing; that it scored 1.875 against 1.857 is not actionable.
 *
 * Same treatment as the strategy notes in engine/measured.js.
 */
export function buildReasoning(pair, floorRelaxed, minWinProbFloorB, runnerUp) {
  const parts = [
    `Entry A: ${describe(pair.pickA)}.`,
    `Entry B: ${describe(pair.pickB)}.`,
  ];

  if (floorRelaxed) {
    parts.push(
      `No team available to Entry B cleared the ${f0(minWinProbFloorB)}% floor this week; `
      + 'the floor was relaxed rather than leave Entry B without a pick.',
    );
  }

  parts.push(
    `Different games (A faces ${pair.pickA.opponentAbbreviation || '?'}, `
    + `B faces ${pair.pickB.opponentAbbreviation || '?'}), so one result cannot end both.`,
  );

  if (runnerUp) {
    parts.push(
      `Beat the next-best pairing, ${runnerUp.pickA.teamAbbreviation}/`
      + `${runnerUp.pickB.teamAbbreviation}.`,
    );
  }

  return parts.join(' ');
}

export function recommend(games, currentWeek, usedTeamsA, usedTeamsB, minWinProbFloorB = DEFAULT_MIN_WIN_PROB_FLOOR) {
  const search = findBestPair(games, usedTeamsA, usedTeamsB, minWinProbFloorB);

  if (!search.best) {
    return {
      week: currentWeek,
      pickA: null, pickB: null,
      bothSurvivePct: null, oneSurvivesPct: null, bothEliminatedPct: null,
      reasoning: 'No valid pick pair available this week (not enough eligible teams/games for both entries).',
      floorRelaxed: search.floorRelaxed,
      pairsConsidered: search.pairsConsidered,
    };
  }

  const best = search.best;
  return {
    week: currentWeek,
    pickA: best.pickA,
    pickB: best.pickB,
    bothSurvivePct: best.bothSurvivePct,
    oneSurvivesPct: best.oneSurvivesPct,
    bothEliminatedPct: best.bothEliminatedPct,
    objectiveScore: best.objectiveScore,
    reasoning: buildReasoning(best, search.floorRelaxed, minWinProbFloorB, search.runnerUp),
    floorRelaxed: search.floorRelaxed,
    pairsConsidered: search.pairsConsidered,
  };
}

/* ------------------------------------------------ the registry contract -- */

export default {
  id: ID,
  name: 'Best pair, chosen together',
  // This said "the only one that can put your two entries on opposite sides of
  // the same game", which is the exact inverse of what the file it sits in
  // does: `sameGame(a, b)` is skipped eleven lines above, so this is the only
  // strategy here that *cannot* reach that holding. It was wrong on the picker
  // screen, at the moment somebody chooses — anyone who wanted that hedge
  // would have been sent to the one strategy structurally refusing to give it.
  //
  // What it actually guarantees is the opposite and is worth saying plainly:
  // the two picks always come from different games, so no single result can
  // take both entries. That is a real property, and it is why the independence
  // assumption in the scoring holds by construction rather than by hope.
  blurb: 'Weighs every legal pair of picks at once and takes the pair most likely to leave at '
    + 'least one entry standing. Always splits them across different games, so no single '
    + 'result can knock out both.',
  entries: 'both',
  params: [
    { key: 'minWinProbFloorB', label: 'Entry B floor', type: 'percent', default: DEFAULT_MIN_WIN_PROB_FLOOR, min: 0, max: 99, help: 'How safe the second entry has to be. Relaxed, loudly, if nothing clears it.' },
  ],

  run(ctx) {
    const [a, b] = ctx.entries;
    const floor = ctx.params.minWinProbFloorB ?? DEFAULT_MIN_WIN_PROB_FLOOR;
    const r = recommend(ctx.games, ctx.week, ctx.usedTeams[a.id] ?? [], ctx.usedTeams[b.id] ?? [], floor);

    const odds = r.pickA ? [
      { label: 'Both survive', value: `${f1(r.bothSurvivePct)}%`, weight: 1 },
      { label: 'One survives', value: `${f1(r.oneSurvivesPct)}%`, weight: 0 },
      { label: 'Both out', value: `${f1(r.bothEliminatedPct)}%`, weight: -1 },
    ] : [];

    const warnings = [];
    if (r.floorRelaxed) {
      warnings.push({ level: 'warn', text: `Nothing available to ${b.name} cleared the ${f0(floor)}% floor. The floor was relaxed rather than leave the entry without a pick.` });
    }
    if (!r.pickA) {
      warnings.push({ level: 'danger', text: 'No legal pair exists this week — not enough eligible teams in different games for both entries.' });
    }

    return {
      strategyId: ID,
      picks: [
        { entry: a.id, candidate: r.pickA, reasoning: r.reasoning, factors: r.pickA ? [
          { label: 'Win probability', value: `${f1(r.pickA.winPct)}%`, weight: 1, note: r.pickA.winPctIsEstimated ? 'Estimated from the spread.' : 'From ESPN.' },
          ...odds,
        ] : [] },
        { entry: b.id, candidate: r.pickB, reasoning: r.reasoning, factors: r.pickB ? [
          { label: 'Win probability', value: `${f1(r.pickB.winPct)}%`, weight: 1, note: r.pickB.winPctIsEstimated ? 'Estimated from the spread.' : 'From ESPN.' },
          ...odds,
        ] : [] },
      ],
      // A joint strategy has no per-entry ranking to offer — its unit of
      // choice is the pair, not the team — so the alternatives shown are the
      // week's board, ranked, for anyone overriding by hand.
      //
      // Pick-first, via the shared helper, and that is not cosmetic here. This
      // used to sort the board by win probability alone, which for a *pair*
      // search is not the same as putting the recommendation first: the best
      // pair routinely contains neither of the two best single teams. The view
      // drops index 0 as the recommendation, so it was dropping an arbitrary
      // team and offering the recommended one back as an alternative to
      // itself.
      candidates: {
        [a.id]: boardBehind(r.pickA, ctx.games, ctx.usedTeams[a.id] ?? []),
        [b.id]: boardBehind(r.pickB, ctx.games, ctx.usedTeams[b.id] ?? []),
      },
      considered: r.pairsConsidered,
      warnings,
      shared: { objectiveScore: r.objectiveScore ?? null, bothSurvivePct: r.bothSurvivePct, oneSurvivesPct: r.oneSurvivesPct, bothEliminatedPct: r.bothEliminatedPct },
    };
  },
};
