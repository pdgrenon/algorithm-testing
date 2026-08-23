/**
 * Plan a sequence of picks, rather than score this week's in isolation.
 *
 * Port of `strategy/sequence_dp.py`, unchanged, and held to it by the golden
 * fixtures. The reasoning for the approach — why a bitmask DP, why the cap is
 * soft, and what multiplying the weeks together does and does not claim — is
 * written out in that module's docstring rather than duplicated here.
 *
 * The short version: `future-value.js` asks "is a better spot coming for this
 * team?", one team at a time. That cannot see that holding a team back only
 * pays if something else covers this week, and cannot notice that two teams it
 * wants to hold are wanted for the same future week. This chooses the sequence,
 * so it sees both:
 *
 *     survival(t1..tN) = P(w1 wins) × P(w2 wins) × … × P(wN wins)
 *
 * maximised over assignments of distinct teams to weeks. Only the first step is
 * acted on; the rest is recomputed next week and returned for display.
 *
 * ── What the backtest actually said ────────────────────────────────────────
 *
 * Recorded here because a strategy's own file is where somebody checks. Over
 * 120 replayed runs (`scripts/backtest.py`, ten seasons from twelve starting
 * weeks) this had the best mean weeks survived of the five, 4.77. Paired
 * against the heuristic it is meant to replace it is +0.33 with a standard
 * error of 0.19 — better every way it was measured, and **not** separable from
 * luck at that sample size. It is offered as a strategy rather than made the
 * default for exactly that reason.
 */

import { isPickable } from '../constraints.js';
import { basisPhrase, resolveTeamWinProbability } from '../win-prob.js';
import { f1 } from '../fmt.js';

export const ID = 'sequence';

export const DEFAULT_LOOKAHEAD_WEEKS = 7;
export const DEFAULT_PER_WEEK_TOP_K = 6;
export const DEFAULT_MAX_CANDIDATE_TEAMS = 14;

/**
 * Order candidates best-first, breaking ties on abbreviation.
 *
 * The second key is not decoration. A board with two teams on identical
 * numbers is common once a spread rounds to the same half point, and an
 * unstable sort there would make the whole plan depend on insertion order —
 * which is exactly the kind of thing that agrees with the Python on a Tuesday
 * and disagrees on a Sunday.
 */
const bestFirst = (a, b) => (b.winPct - a.winPct)
  || (a.teamAbbreviation < b.teamAbbreviation ? -1 : a.teamAbbreviation > b.teamAbbreviation ? 1 : 0);

/** This week's candidates, from the games in hand — they carry the spread text. */
export function optionsThisWeek(games, excluded) {
  const options = [];
  for (const game of games) {
    if (!isPickable(game)) continue;
    const spreadDetail = game.odds ? game.odds.details : null;
    for (const isHome of [true, false]) {
      const team = isHome ? game.home : game.away;
      const opponent = isHome ? game.away : game.home;
      if (!team.abbreviation || excluded.has(team.abbreviation)) continue;
      const resolved = resolveTeamWinProbability(game, isHome);
      if (resolved.winPct === null || resolved.winPct === undefined) continue;
      options.push({
        week: game.week,
        teamAbbreviation: team.abbreviation,
        opponentAbbreviation: opponent.abbreviation,
        isHome,
        winPct: resolved.winPct,
        winPctSource: resolved.source,
        winPctIsEstimated: resolved.source === 'spread_estimate',
        spreadDetail,
        eventId: game.eventId,
      });
    }
  }
  return options.sort(bestFirst);
}

/** A future week's candidates, from the season table both engines carry. */
export function optionsFromTable(table, week, excluded) {
  const options = [];
  for (const [k, entry] of table) {
    const bar = k.lastIndexOf('|');
    if (Number(k.slice(bar + 1)) !== week) continue;
    const team = k.slice(0, bar);
    if (excluded.has(team) || entry.winPct === null || entry.winPct === undefined) continue;
    options.push({
      week,
      teamAbbreviation: team,
      opponentAbbreviation: entry.opponentAbbreviation,
      isHome: entry.isHome,
      winPct: entry.winPct,
      winPctSource: entry.source,
      winPctIsEstimated: entry.source === 'spread_estimate',
      spreadDetail: null,
      eventId: null,
    });
  }
  return options.sort(bestFirst);
}

/** Prune each week to a small, searchable universe. Additive-only at the cap. */
export function buildCandidateUniverse(
  weeklyOptions,
  perWeekTopK = DEFAULT_PER_WEEK_TOP_K,
  maxCandidateTeams = DEFAULT_MAX_CANDIDATE_TEAMS,
) {
  const topk = new Map();
  for (const week of [...weeklyOptions.keys()].sort((a, b) => a - b)) {
    topk.set(week, weeklyOptions.get(week).slice(0, perWeekTopK));
  }

  const bestAnywhere = new Map();
  for (const options of topk.values()) {
    for (const o of options) {
      bestAnywhere.set(o.teamAbbreviation, Math.max(bestAnywhere.get(o.teamAbbreviation) ?? 0, o.winPct));
    }
  }

  const kept = new Set();
  const ranked = [...bestAnywhere.keys()].sort((a, b) => (bestAnywhere.get(b) - bestAnywhere.get(a))
    || (a < b ? -1 : a > b ? 1 : 0));
  for (const team of ranked) {
    if (kept.size >= maxCandidateTeams) break;
    kept.add(team);
  }

  // A week trimmed bare gets its own best team back. Never an eviction: a team
  // kept for one week's sake is not given up to make room for another.
  for (const week of [...topk.keys()].sort((a, b) => a - b)) {
    const options = topk.get(week);
    if (options.length && !options.some((o) => kept.has(o.teamAbbreviation))) {
      kept.add(options[0].teamAbbreviation);
    }
  }

  const out = new Map();
  for (const [week, options] of topk) {
    out.set(week, options.filter((o) => kept.has(o.teamAbbreviation)));
  }
  return out;
}

/**
 * The all-distinct-teams sequence maximising the product of win probabilities.
 *
 * A bitmask over the candidate universe: `dp` maps a set of teams already spent
 * to the best product that reaches it, and the path that did.
 */
export function solve(weeklyOptions) {
  const orderedWeeks = [...weeklyOptions.keys()].sort((a, b) => a - b);
  const universe = [...new Set(
    orderedWeeks.flatMap((w) => weeklyOptions.get(w).map((o) => o.teamAbbreviation)),
  )].sort();
  const indexOf = new Map(universe.map((t, i) => [t, i]));

  let dp = new Map([[0, { product: 1.0, path: [] }]]);
  let advanced = false;

  for (const week of orderedWeeks) {
    const options = weeklyOptions.get(week);
    if (!options.length) continue;
    const next = new Map();
    for (const [mask, { product, path }] of dp) {
      for (const o of options) {
        const bit = 1 << indexOf.get(o.teamAbbreviation);
        if (mask & bit) continue;          // already spent in this sequence
        const newMask = mask | bit;
        const newProduct = product * (o.winPct / 100.0);
        const current = next.get(newMask);
        if (current === undefined || newProduct > current.product) {
          next.set(newMask, { product: newProduct, path: [...path, o] });
        }
      }
    }
    // Every candidate this week was already spent by every surviving sequence.
    // Carry the sequences forward rather than dropping them.
    if (next.size === 0) continue;
    dp = next;
    advanced = true;
  }

  if (!advanced) return { product: 0.0, path: [] };

  let best = null;
  for (const entry of dp.values()) {
    if (best === null
      || entry.product > best.product
      || (entry.product === best.product && entry.path.length < best.path.length)) {
      best = entry;
    }
  }
  return best;
}

function describe(option) {
  const basis = basisPhrase(option.winPctSource);
  const spread = option.spreadDetail ? `, spread ${option.spreadDetail}` : '';
  return `${option.teamAbbreviation} vs ${option.opponentAbbreviation ?? '?'} -- `
    + `${f1(option.winPct)}% win prob${basis}${spread}`;
}

function buildReasoning(pick, path, product, universe) {
  const parts = [`Top pick: ${describe(pick)}.`];
  if (path.length > 1) {
    const plan = path.slice(1).map((p) => `wk ${p.week} ${p.teamAbbreviation}`).join(', ');
    parts.push(`Chosen as the first step of the best ${path.length}-week sequence `
      + `(${plan}), searched over ${universe.length} candidate teams.`);
    parts.push(`That whole sequence comes out at ${f1(product * 100)}% to survive, treating the `
      + 'weeks as independent -- a way of ranking plans against each other rather than a '
      + 'figure to quote.');
  } else {
    parts.push('Only this week had candidates, so no sequence was searched and this is '
      + 'the highest win probability available.');
  }
  parts.push("Only this week's pick is meant to be acted on; the rest is recomputed next week.");
  return parts.join(' ');
}

/** This week's pick, as the first step of the best sequence over the window. */
export function recommend(games, table, week, usedTeams = [], opts = {}) {
  const lookahead = opts.lookaheadWeeks ?? DEFAULT_LOOKAHEAD_WEEKS;
  const perWeekTopK = opts.perWeekTopK ?? DEFAULT_PER_WEEK_TOP_K;
  const maxTeams = opts.maxCandidateTeams ?? DEFAULT_MAX_CANDIDATE_TEAMS;

  const excluded = new Set(usedTeams);
  const weekly = new Map();

  const thisWeek = optionsThisWeek(games, excluded);
  if (thisWeek.length) weekly.set(week, thisWeek);
  for (let w = week + 1; w < week + lookahead; w += 1) {
    const options = optionsFromTable(table, w, excluded);
    if (options.length) weekly.set(w, options);
  }

  if (!weekly.has(week)) {
    return {
      week, pick: null, path: [], survivalPct: null, candidateUniverse: [],
      reasoning: 'No eligible teams available this week (all used, or no game data).',
      alternatives: [],
    };
  }

  const universeOptions = buildCandidateUniverse(weekly, perWeekTopK, maxTeams);
  const { product, path } = solve(universeOptions);
  const alternatives = weekly.get(week);

  if (!path.length || path[0].week !== week) {
    const best = alternatives[0];
    return {
      week,
      pick: best,
      path: [best],
      survivalPct: best.winPct,
      candidateUniverse: [best.teamAbbreviation],
      reasoning: `Top pick: ${describe(best)}. No multi-week sequence could be built from this `
        + 'board, so this is the highest win probability available.',
      alternatives: alternatives.slice(1),
    };
  }

  const universe = [...new Set(
    [...universeOptions.values()].flat().map((o) => o.teamAbbreviation),
  )].sort();

  return {
    week,
    pick: path[0],
    path,
    survivalPct: product * 100.0,
    candidateUniverse: universe,
    reasoning: buildReasoning(path[0], path, product, universe),
    alternatives: alternatives.filter((o) => o.teamAbbreviation !== path[0].teamAbbreviation),
  };
}

/** The prose above, as something the interface can lay out. */
function factorsFor(result) {
  const pick = result.pick;
  const f = [{
    label: 'Win probability',
    value: `${f1(pick.winPct)}%`,
    weight: 1,
    note: pick.winPctIsEstimated
      ? 'Estimated from the spread — no moneyline or ESPN model for this game.'
      : (pick.winPctSource === 'moneyline' ? "De-vigged from the book's own prices." : 'From ESPN.'),
  }];
  if (result.path.length > 1) {
    f.push({
      label: 'Plan',
      value: `${result.path.length} weeks`,
      weight: 0,
      note: result.path.slice(1).map((p) => `wk ${p.week} ${p.teamAbbreviation}`).join(' · '),
    });
    f.push({
      label: 'Sequence survival',
      value: `${f1(result.survivalPct)}%`,
      weight: 1,
      note: 'Weeks treated as independent. A way of ranking plans, not a figure to quote.',
    });
  }
  f.push({
    label: 'Searched',
    value: `${result.candidateUniverse.length} teams`,
    weight: 0,
    note: 'Exact over the pruned candidate set, not over the whole league.',
  });
  return f;
}

export default {
  id: ID,
  name: 'Plan the sequence',
  blurb: 'Searches for the run of distinct teams most likely to survive the next several weeks, '
    + 'and takes the first step of it.',
  entries: 'single',
  params: [
    { key: 'lookaheadWeeks', label: 'Plan over', type: 'int', default: DEFAULT_LOOKAHEAD_WEEKS, min: 2, max: 12, unit: 'weeks', help: 'How many weeks the plan covers. Only the first is ever acted on.' },
    { key: 'perWeekTopK', label: 'Teams per week', type: 'int', default: DEFAULT_PER_WEEK_TOP_K, min: 2, max: 10, help: 'How many of each week\'s best teams are considered at all.' },
    { key: 'maxCandidateTeams', label: 'Search width', type: 'int', default: DEFAULT_MAX_CANDIDATE_TEAMS, min: 6, max: 20, unit: 'teams', help: 'Soft cap on distinct teams across the whole plan. Every week keeps at least one.' },
  ],

  run(ctx) {
    const opts = {
      lookaheadWeeks: ctx.params.lookaheadWeeks ?? DEFAULT_LOOKAHEAD_WEEKS,
      perWeekTopK: ctx.params.perWeekTopK ?? DEFAULT_PER_WEEK_TOP_K,
      maxCandidateTeams: ctx.params.maxCandidateTeams ?? DEFAULT_MAX_CANDIDATE_TEAMS,
    };
    const perEntry = {};
    const picks = [];

    for (const entry of ctx.entries) {
      const r = recommend(ctx.games, ctx.schedule, ctx.week, ctx.usedTeams[entry.id] ?? [], opts);
      perEntry[entry.id] = r.pick ? [r.pick, ...r.alternatives] : [];
      picks.push({
        entry: entry.id,
        candidate: r.pick,
        reasoning: r.reasoning,
        factors: r.pick ? factorsFor(r) : [],
      });
    }

    const warnings = [];
    if (ctx.scheduleWeeks <= 1) {
      warnings.push({
        level: 'warn',
        text: 'Only this week is loaded, so there is no sequence to plan and this ranks identically to win probability.',
      });
    }
    // Same hazard entry-a-value has and does not report: two entries reasoned
    // about one at a time can land on the same team, which is two entries in
    // name only.
    const teams = picks.map((p) => p.candidate?.teamAbbreviation).filter(Boolean);
    if (teams.length > 1 && new Set(teams).size === 1) {
      warnings.push({
        level: 'warn',
        text: `Both entries' pick is ${teams[0]}. One result would eliminate both — take the runner-up for one of them.`,
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
