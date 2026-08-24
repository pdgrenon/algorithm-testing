/**
 * Plan a sequence of picks, rather than score this week's in isolation.
 *
 * Port of `strategy/sequence_dp.py`, and held to it by the golden fixtures.
 * The reasoning — why expected weeks rather than the product, why a beam
 * search rather than the exact DP, why the candidate cap is soft — is written
 * out in that module's docstring rather than duplicated here.
 *
 * The short version. `future-value.js` asks "is a better spot coming for this
 * team?", one team at a time, and so cannot see that holding a team back only
 * pays if something else covers this week. This chooses the whole sequence:
 *
 *     E[weeks survived] = sum over i of ( product of p_1 .. p_i )
 *
 * maximised over assignments of distinct teams to weeks. Only the first step
 * is acted on; the rest is recomputed next week and returned for display.
 *
 * ── Why that objective and not the product ─────────────────────────────────
 *
 * This maximised the plain product until the pool's payout rule was pinned
 * down. The product asks "will I go unbeaten", which is the question only if
 * the pot needs a perfect season. It does not here: the expected number of
 * unbeaten entries out of 250 is 0.87, so the modal season ends with nobody
 * perfect and the deepest survivors splitting. Depth pays on its own.
 *
 * Expected weeks is also order-sensitive where the product is blind:
 *
 *     0.90 then 0.50   product 0.450   expected weeks 1.350
 *     0.50 then 0.90   product 0.450   expected weeks 0.950
 *
 * Same teams, same product, 0.4 of a week apart. That pair is also why the
 * bitmask DP had to become a beam search — it is a state the old solver could
 * not rank, because one scalar per (week, teams-used) cannot order two paths
 * whose continuations scale with different running products.
 *
 * ── What the backtest said about the earlier version ───────────────────────
 *
 * Recorded because a strategy's own file is where somebody checks. Over 120
 * replayed runs (`scripts/backtest.py`, ten seasons from twelve starting
 * weeks) the product version had the best mean weeks survived of the five,
 * 4.77 — and against the heuristic it replaces, +0.33 with a standard error
 * of 0.19: better every way it was measured and **not** separable from luck.
 * It is offered as a strategy rather than made the default for that reason.
 * The objective has changed since; re-measure before believing that figure
 * still describes it.
 */

import { isPickable } from '../constraints.js';
import { basisPhrase, resolveTeamWinProbability } from '../win-prob.js';
import { f1 } from '../fmt.js';

export const ID = 'sequence';

export const DEFAULT_LOOKAHEAD_WEEKS = 7;
export const DEFAULT_PER_WEEK_TOP_K = 6;
export const DEFAULT_MAX_CANDIDATE_TEAMS = 14;

// How many partial plans the beam carries.
//
// Was 2000, which cost about 350 ms per `distinct` run and changed nothing.
// The binding constraint is the candidate pruning above: at
// DEFAULT_MAX_CANDIDATE_TEAMS teams over DEFAULT_LOOKAHEAD_WEEKS weeks the
// search never needs anywhere near that many live states, so the extra width
// was sorted and sliced every step and then thrown away. That mattered because
// the Week screen runs this on every render — 571 ms measured in a browser on
// a desktop, for the screen this app promises has no spinner.
//
// Verified before changing, because the published ratings were measured at
// this value: over 72 board states — all 18 weeks, four generated inventories
// each — across `distinct` and `leverage`, both entries, a width of 50 gives
// 144 of 144 identical picks against 2000, with identical reasoning and factor
// rows on spot checks. The measurement still describes what runs.
//
// 200 rather than the verified 50: a wider beam is strictly closer to
// exhaustive, so it sits between two settings shown to agree, and it leaves
// room for a real board carrying more candidates than the fixtures do.
export const DEFAULT_BEAM_WIDTH = 200;

// Dedup resolution for the running product, as an integer so the two engines
// agree exactly. Python's round() and JavaScript's toFixed() disagree on
// halves, and a dedup key that differed between them would silently give the
// two engines different beams — which the parity fixtures would report as a
// mystery rather than as a rounding bug.
const PRODUCT_QUANTUM = 1e9;

/** How many teams a plan's bitmask can hold. See the guard in solve(). */
const MASK_BITS = 32;

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
        // Carried so the view can tell whether this game has kicked off.
        // `isPickable` above only reads ESPN's `state`, which lags: there is a
        // window where the ball is in the air and the feed still says "pre".
        // week.js closes it with `hasStarted`, a clock comparison against
        // startDate -- and with startDate absent that check silently returns
        // false for every pick this function produces. `distinct` and
        // `leverage` are built on it, and `distinct` is the app default, so
        // the one guard against recording a pick after kickoff was inert on
        // the strategy most people use. buildOptions in constraints.js has
        // always carried it, which is why `joint` was never exposed.
        startDate: game.startDate,
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
 * The all-distinct-teams sequence maximising expected weeks survived.
 *
 * Returns `{ expectedWeeks, product, path }`. The product is carried for
 * display — it is the chance the whole plan comes off — but it is not what is
 * being maximised.
 */
export function solve(weeklyOptions, beamWidth = DEFAULT_BEAM_WIDTH) {
  const orderedWeeks = [...weeklyOptions.keys()].sort((a, b) => a - b);
  const universe = [...new Set(
    orderedWeeks.flatMap((w) => weeklyOptions.get(w).map((o) => o.teamAbbreviation)),
  )].sort();
  // The teams-used set is a bitmask, and JavaScript's shift operators work on
  // 32-bit signed integers: `1 << 32` is 1, not a 33rd bit, so team 32 would
  // share a bit with team 0 and the search would call a plan illegal because
  // of a team it never spent. Python's mask is arbitrary precision and has no
  // such edge, so nothing on that side would report the difference.
  //
  // Unreachable through the registry -- the declared caps are 20 teams over 12
  // weeks, and the soft cap adds back at most one team per week -- but `solve`
  // and `recommend` are exported and take their options straight from the
  // caller. Loud rather than quietly wrong, which is the whole reason the
  // limit is written down here at all.
  if (universe.length > MASK_BITS) {
    throw new RangeError(
      `sequence-dp searches at most ${MASK_BITS} teams; got ${universe.length}. `
      + 'Lower maxCandidateTeams or lookaheadWeeks.',
    );
  }
  const indexOf = new Map(universe.map((t, i) => [t, i]));

  // [expectedWeeks, product, mask, path]
  let beam = [[0.0, 1.0, 0, []]];
  let advanced = false;

  for (const week of orderedWeeks) {
    const options = weeklyOptions.get(week);
    if (!options.length) continue;

    const candidates = [];
    for (const plan of beam) {
      const [expected, product, mask, path] = plan;
      let extended = false;
      for (const o of options) {
        const bit = 1 << indexOf.get(o.teamAbbreviation);
        if (mask & bit) continue;               // already spent in this plan
        const nextProduct = product * (o.winPct / 100.0);
        candidates.push([expected + nextProduct, nextProduct, mask | bit, [...path, o]]);
        extended = true;
      }
      // A plan that cannot take any of this week's teams survives unchanged.
      //
      // It used to be dropped, silently, and that inverts the objective on a
      // narrow board. `expectedWeeks` only ever increases with plan length, so
      // a plan that stops accumulating loses to every plan that keeps going —
      // which means the winner becomes whichever plan happened to reach the
      // end of the window, not the plan worth the most. On a board of
      // `wk1 KC 99% / CAR 1%`, `wk2 KC 50%`, the solver preferred CAR at
      // E=0.015 over KC at E=0.99, because taking KC in week 1 left nothing
      // takeable in week 2 and deleted the plan.
      //
      // Carrying it forward is enough: the dedup key is (mask, product), both
      // unchanged, so a carried plan collapses onto itself rather than
      // multiplying. The module's own docstring already says a stuck plan is
      // meant to be ranked, not discarded.
      if (!extended) candidates.push(plan);
    }
    // Every candidate this week was already spent by every surviving plan.
    if (!candidates.length) continue;

    // Dedup on (teams used, running product), keeping the best accumulated
    // value. Different products are deliberately kept apart — that is exactly
    // the pair the beam has to be able to rank, and collapsing it is what
    // makes a single-scalar state wrong for this objective.
    const bestByKey = new Map();
    for (const c of candidates) {
      const key = `${c[2]}|${Math.floor(c[1] * PRODUCT_QUANTUM)}`;
      const current = bestByKey.get(key);
      if (current === undefined || c[0] > current[0]) bestByKey.set(key, c);
    }

    const ranked = [...bestByKey.values()].sort((x, y) => {
      if (y[0] !== x[0]) return y[0] - x[0];
      const xs = x[3].map((o) => o.teamAbbreviation).join('|');
      const ys = y[3].map((o) => o.teamAbbreviation).join('|');
      return xs < ys ? -1 : xs > ys ? 1 : 0;
    });
    beam = ranked.slice(0, beamWidth);
    advanced = true;
  }

  if (!advanced) return { expectedWeeks: 0.0, product: 0.0, path: [] };
  const [expectedWeeks, product, , path] = beam[0];
  return { expectedWeeks, product, path };
}

/**
 * What spending each candidate team costs, in weeks of plan.
 *
 * The shadow price from models/future_value.py, with this module's search as
 * the V: `FV(t) = V(S) - V(S \ {t})`. Because V is the objective, the answer
 * is in the objective's units — "taking KC costs 0.4 weeks" is a sentence with
 * a meaning rather than a number on its own scale.
 *
 * This is what `future-value.js` cannot compute. Scoring one team at a time
 * cannot tell that two teams are interchangeable: if both are the best option
 * in week 12 the heuristic calls each valuable, when at most one of them
 * actually is. Removing one here leaves the other to fill the slot, so V
 * barely moves and both come out cheap — correctly.
 *
 * Priced over the pruned universe only, so a team the search never considers
 * is free by construction. True of the plan, not of the season.
 */
export function shadowPrices(universeOptions, beamWidth = DEFAULT_BEAM_WIDTH) {
  const candidates = [...new Set(
    [...universeOptions.values()].flat().map((o) => o.teamAbbreviation),
  )].sort();

  const valueOf = (inventory) => {
    const trimmed = new Map();
    for (const [week, options] of universeOptions) {
      trimmed.set(week, options.filter((o) => inventory.has(o.teamAbbreviation)));
    }
    return solve(trimmed, beamWidth).expectedWeeks;
  };

  const all = new Set(candidates);
  const base = valueOf(all);
  const out = [];
  for (const team of candidates) {
    const without = new Set(all);
    without.delete(team);
    out.push([team, base - valueOf(without)]);
  }
  out.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new Map(out);
}

function describe(option) {
  const basis = basisPhrase(option.winPctSource);
  const spread = option.spreadDetail ? `, spread ${option.spreadDetail}` : '';
  return `${option.teamAbbreviation} vs ${option.opponentAbbreviation ?? '?'} -- `
    + `${f1(option.winPct)}% win prob${basis}${spread}`;
}

/**
 * One or two sentences, shown per pick on a phone and in the CLI report.
 *
 * Port of `_build_reasoning` in strategy/sequence_dp.py, and held to it
 * character for character by the parity suite and fixtures/golden.
 *
 * Two standing caveats used to be appended to every pick and are recorded here
 * instead, because they are properties of the method rather than news about
 * this week:
 *
 *   * `expectedWeeks` and `product` both treat the weeks as independent, so
 *     they rank plans against each other and are not figures to quote.
 *   * expected length is what is maximised, not the chance of a clean run --
 *     the pot splits among whoever gets deepest, so a week of survival pays on
 *     its own.
 *
 * Both were true, and repeating them under every pick, every week, is how a
 * recommendation screen turns into a methods section. The same thing happened
 * to the strategy notes in engine/measured.js; see the comment above MEASURED.
 *
 * `product` is deliberately no longer quoted here. Naming both numbers in one
 * sentence is what made the caveat necessary — "5.6 weeks" and "64.7% chance
 * of running clean" are different claims and a reader cannot tell which the
 * search aimed at. Quoting only the objective removes the ambiguity instead of
 * annotating it; the other number is still on screen as its own factor row,
 * beside the one it contrasts with.
 */
function buildReasoning(pick, path, expectedWeeks, product, universe) {
  const parts = [`Top pick: ${describe(pick)}.`];
  if (path.length > 1) {
    const plan = path.slice(1).map((p) => `wk ${p.week} ${p.teamAbbreviation}`).join(', ');
    parts.push(`First step of the best plan over ${universe.length} teams: ${plan}. `
      + `Worth about ${f1(expectedWeeks)} weeks of survival, which is what is maximised.`);
    parts.push("Only this week's pick is acted on; the plan is recomputed next week.");
  } else {
    parts.push('Only this week had candidates, so no plan was searched and this is '
      + 'the highest win probability available.');
  }
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
      week, pick: null, path: [], expectedWeeks: null, survivalPct: null, candidateUniverse: [],
      reasoning: 'No eligible teams available this week (all used, or no game data).',
      alternatives: [],
    };
  }

  const universeOptions = buildCandidateUniverse(weekly, perWeekTopK, maxTeams);
  const beamWidth = opts.beamWidth ?? DEFAULT_BEAM_WIDTH;
  const { expectedWeeks, product, path } = solve(universeOptions, beamWidth);
  const prices = shadowPrices(universeOptions, beamWidth);
  const alternatives = weekly.get(week);

  if (!path.length || path[0].week !== week) {
    const best = alternatives[0];
    return {
      week,
      pick: best,
      path: [best],
      expectedWeeks: best.winPct / 100.0,
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
    expectedWeeks,
    survivalPct: product * 100.0,
    shadowPrices: prices,
    candidateUniverse: universe,
    reasoning: buildReasoning(path[0], path, expectedWeeks, product, universe),
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
      label: 'Expected length',
      value: `${f1(result.expectedWeeks)} wks`,
      weight: 1,
      note: 'What is maximised. The pot splits among whoever gets deepest, so a week of survival pays on its own.',
    });
    f.push({
      label: 'Whole plan holds',
      value: `${f1(result.survivalPct)}%`,
      weight: 0,
      note: 'Weeks treated as independent. A way of ranking plans, not a figure to quote.',
    });
  }
  const price = result.shadowPrices?.get(pick.teamAbbreviation);
  if (price !== undefined && result.path.length > 1) {
    const rivals = [...(result.shadowPrices ?? new Map())]
      .filter(([t]) => t !== pick.teamAbbreviation && result.path.some((p) => p.teamAbbreviation === t));
    const dearest = rivals.length ? rivals[0] : null;
    f.push({
      label: 'Costs you',
      value: `${f1(price)} wks`,
      weight: -1,
      note: dearest
        ? `What the plan loses by spending them now. ${dearest[0]} is the dearer team to give up, at ${f1(dearest[1])} — which is why it is being held.`
        : 'What the plan loses by spending them now, rather than keeping them for a week that needs them.',
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
  name: 'Plans several weeks ahead',
  blurb: 'Looks for the best run of teams over the coming weeks — each used only once — and '
    + 'plays the first step of it. Leans safe early, because getting through this week is what '
    + 'buys you the rest.',
  entries: 'single',
  params: [
    { key: 'lookaheadWeeks', label: 'Plan over', type: 'int', default: DEFAULT_LOOKAHEAD_WEEKS, min: 2, max: 12, unit: 'weeks', help: 'How many weeks the plan covers. Only the first is ever acted on, and this week\'s pick barely moves with it — measured at 7.' },
    { key: 'perWeekTopK', label: 'Teams per week', type: 'int', default: DEFAULT_PER_WEEK_TOP_K, min: 2, max: 10, help: 'How many of each week\'s best teams are considered at all. Below about 4 it starts missing picks; above the default it changes nothing — measured at 6.' },
    { key: 'maxCandidateTeams', label: 'Search width', type: 'int', default: DEFAULT_MAX_CANDIDATE_TEAMS, min: 6, max: 20, unit: 'teams', help: 'Soft cap on teams across the whole plan; every week keeps at least one. Below the default it starts missing picks — measured at 14.' },
    // `beamWidth` is deliberately NOT offered here.
    //
    // It is the one parameter that provably does nothing: swept from 1 to
    // 2000 across all 18 weeks and four inventories, every pick was identical,
    // because the candidate pruning binds long before the beam does. A slider
    // whose own help text has to admit it changes nothing is not a setting,
    // it is a distraction with a number next to it — and the help text had
    // already gone stale, still claiming "measured at 2000" after the default
    // became 200.
    //
    // The knob still exists on the engine: `opts.beamWidth` is honoured, the
    // backtest can sweep it, and the tests set it. What is gone is the
    // pretence that a person should be choosing it.
  ],

  run(ctx) {
    const opts = {
      lookaheadWeeks: ctx.params.lookaheadWeeks ?? DEFAULT_LOOKAHEAD_WEEKS,
      perWeekTopK: ctx.params.perWeekTopK ?? DEFAULT_PER_WEEK_TOP_K,
      maxCandidateTeams: ctx.params.maxCandidateTeams ?? DEFAULT_MAX_CANDIDATE_TEAMS,
      beamWidth: ctx.params.beamWidth ?? DEFAULT_BEAM_WIDTH,
    };
    const perEntry = {};
    const picks = [];
    const weighed = new Set();

    for (const entry of ctx.entries) {
      const r = recommend(ctx.games, ctx.schedule, ctx.week, ctx.usedTeams[entry.id] ?? [], opts);
      for (const team of r.candidateUniverse ?? []) weighed.add(team);
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
      // What the search weighed, not how many alternatives sit under it. See
      // the note in distinct.js: once `candidates` became the full board for
      // the override, this started reporting the size of that list as the
      // effort behind the pick, which overstated it by more than four times.
      considered: weighed.size,
      warnings,
    };
  },
};
