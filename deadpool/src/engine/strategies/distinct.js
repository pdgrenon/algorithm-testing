/**
 * Both entries from one strategy, forbidden from landing on the same team.
 *
 * A port of strategy/distinct.py, and held to it by fixtures/golden.
 *
 * The simplest thing you can do with two entries, and the one the harness
 * measures at the top of the table: pick for each entry, and if the second
 * wants the team the first took, pick again with that team struck off.
 *
 * ── Why this exists next to the joint optimizer ─────────────────────────
 *
 * `joint` searches every legal pair at once under three hard constraints --
 * different games, never the same team, and a floor on the second entry's win
 * probability -- and for a long time nothing here could tell the two apart.
 * This file called it a dead heat. Two things ended it: quadrupling the sample
 * made the gap grow rather than collapse, which is the shape a real difference
 * has, and pairing on weeks survived as well as on money put a second metric
 * with different noise behind the same direction. `distinct` is measurably
 * ahead on both.
 *
 * The figures are in engine/measured.js and are deliberately not restated
 * here -- not the old ones, and not the new ones either. They were once, and
 * they rotted: this file claimed t = 0.47 over 34 seasons to 35 while the
 * table and strategy/distinct.py both said t = 0.73 over 94 to 73, from the
 * run actually reported on the settings screen. A number written down twice is
 * a number that will disagree with itself, and the disagreement is silent --
 * the same reason a note in that table names another strategy by id rather
 * than by name. Whether the separation holds is a live question there, not
 * here.
 *
 * That is measured against a *simulated* field whose concentration is a prior
 * rather than an observation. Once real pick data arrives that prior can be
 * fitted, and a comparison made under an assumed field is not guaranteed to
 * survive a measured one. So both are offered.
 *
 * They also differ in a way the tie hides: `joint`'s constraints make some
 * holdings unreachable -- it cannot put the two entries on opposite sides of
 * one game, the hedge that becomes decisive against a field concentrated on a
 * single team. This has no constraint beyond the one in its name.
 *
 * ── Unconstrained first, and only then the exclusion ────────────────────
 *
 * Each entry is asked what it wants on its own, and the exclusion applies only
 * where two actually want the same team. That is not an optimisation for its
 * own sake: it lets the warning below be truthful about whether the rule bound
 * at all, and a week where it did not is a week this is identical to running
 * the underlying strategy twice. Saying so is worth more than hiding it.
 */

import { recommend, DEFAULT_LOOKAHEAD_WEEKS, DEFAULT_PER_WEEK_TOP_K, DEFAULT_MAX_CANDIDATE_TEAMS, DEFAULT_BEAM_WIDTH } from './sequence-dp.js';
import { f1 } from '../fmt.js';
import { boardBehind } from '../constraints.js';

const ID = 'distinct';

/**
 * Each entry's own best pick, with collisions resolved in entry order.
 *
 * Returns `{ picks, reasoning, collided }` keyed by entry id, matching the
 * Python. `collided` lists the entries that had to move.
 */
export function recommendDistinct(games, table, week, usedByEntry = {}, order = [], opts = {}) {
  const picks = {};
  const reasoning = {};
  const collided = [];
  const taken = [];

  for (const entry of order) {
    const used = usedByEntry[entry] ?? [];
    let r = recommend(games, table, week, used, opts);
    if (r.pick && taken.includes(r.pick.teamAbbreviation)) {
      collided.push(entry);
      r = recommend(games, table, week, [...used, ...taken], opts);
    }
    picks[entry] = r.pick ?? null;
    reasoning[entry] = r.reasoning;
    if (r.pick) {
      if (taken.includes(r.pick.teamAbbreviation)) {
        // Unreachable: it was excluded above. Thrown rather than assumed,
        // because a silent collision is the one failure this exists to
        // prevent and nothing downstream would notice it.
        throw new Error(`${entry} was given ${r.pick.teamAbbreviation}, already taken this week`);
      }
      taken.push(r.pick.teamAbbreviation);
    }
  }
  // `week` is on the Python's DistinctRecommendation and was missing here, so
  // parity.test.js had to supply its own `spec.week` for this one strategy —
  // comparing a constant it had just written against itself, while every other
  // strategy in that file reads the engine's own field. `distinct` is the app
  // default, so it was the one whose week nothing checked.
  return { week, picks, reasoning, collided };
}

/* ------------------------------------------------ the registry contract -- */

export default {
  id: ID,
  name: 'Different team for each entry',
  blurb: 'Plans each entry on its own, then moves the second one off the first\'s team when both '
    + 'want it. That one rule is worth more than any of the cleverness inside the plans '
    + 'themselves.',
  entries: 'both',
  params: [
    { key: 'lookaheadWeeks', label: 'Plan over', type: 'int', default: DEFAULT_LOOKAHEAD_WEEKS, min: 2, max: 12, unit: 'weeks', help: 'How many weeks each entry\'s plan covers. Only the first is ever acted on, and this week\'s pick barely moves with it — measured at 7.' },
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
    const order = ctx.entries.map((e) => e.id);
    const usedByEntry = Object.fromEntries(order.map((id) => [id, ctx.usedTeams[id] ?? []]));
    const { picks, reasoning, collided } = recommendDistinct(
      ctx.games, ctx.schedule, ctx.week, usedByEntry, order, opts,
    );

    const perEntry = {};
    const out = [];
    for (const entry of ctx.entries) {
      const pick = picks[entry.id];
      perEntry[entry.id] = boardBehind(pick, ctx.games, usedByEntry[entry.id] ?? []);
      out.push({
        entry: entry.id,
        candidate: pick,
        reasoning: reasoning[entry.id],
        factors: pick ? [{
          label: 'Win probability',
          // f1, not toFixed: this factor sits directly above the reasoning
          // sentence, which is formatted the Python way. toFixed rounds a half
          // away from zero and Python rounds it to even, so 78.25 read "78.3%"
          // in the row and "78.2% win prob" in the line under it -- one number,
          // two answers, on the same card.
          value: pick.winPct === null || pick.winPct === undefined ? null : `${f1(pick.winPct)}%`,
          weight: 1,
          note: collided.includes(entry.id)
            ? 'Moved off another entry\'s team — this was not its first choice.'
            : 'Its own first choice; no other entry wanted it.',
        }] : [],
      });
    }

    const warnings = [];
    if (ctx.scheduleWeeks <= 1) {
      warnings.push({ level: 'warn', text: 'Only this week is loaded, so there is no sequence to plan and this ranks identically to win probability.' });
    }
    // Deliberately no banner for "nothing collided". It would fire most weeks
    // -- entries hold different inventories, so they usually want different
    // teams anyway -- and a notice that says nothing happened, every week,
    // stops being read and is then worth nothing on the week it matters. The
    // per-pick note below carries it, attached to the pick it is about.

    return { strategyId: ID, picks: out, candidates: perEntry, considered: Object.values(perEntry).reduce((n, c) => n + c.length, 0), warnings };
  },
};
