/**
 * Both entries from one strategy, forbidden from landing on the same team.
 *
 * A port of strategy/distinct.py, and held to it by fixtures/golden.
 *
 * The simplest thing you can do with two entries, and the one the harness
 * measured at the top of every run: pick for each entry, and if the second
 * wants the team the first took, pick again with that team struck off.
 *
 * ── Why this exists next to the joint optimizer ─────────────────────────
 *
 * `joint` searches every legal pair at once under three hard constraints --
 * different games, never the same team, and a floor on the second entry's win
 * probability -- and 2,500 simulated seasons could not tell the two apart:
 * t = 0.47 on the paired difference, 34 seasons to 35. A dead heat.
 *
 * That is measured against a *simulated* field whose concentration is a prior
 * rather than an observation. Once real pick data arrives that prior can be
 * fitted, and a comparison level under an assumed field is not guaranteed to
 * stay level under a measured one. So both are offered.
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
  return { picks, reasoning, collided };
}

/* ------------------------------------------------ the registry contract -- */

export default {
  id: ID,
  name: 'One strategy, twice, no overlap',
  blurb: 'Plans each entry on its own, then moves the second entry off the first one\'s team if '
    + 'they collide. No other coordination — the two entries are otherwise independent.',
  entries: 'both',
  params: [
    { key: 'lookaheadWeeks', label: 'Plan over', type: 'int', default: DEFAULT_LOOKAHEAD_WEEKS, min: 2, max: 12, unit: 'weeks', help: 'How many weeks each entry\'s plan covers. Only the first is ever acted on.' },
    { key: 'perWeekTopK', label: 'Teams per week', type: 'int', default: DEFAULT_PER_WEEK_TOP_K, min: 2, max: 10, help: 'How many of each week\'s best teams are considered at all.' },
    { key: 'maxCandidateTeams', label: 'Search width', type: 'int', default: DEFAULT_MAX_CANDIDATE_TEAMS, min: 6, max: 20, unit: 'teams', help: 'Soft cap on distinct teams across the whole plan. Every week keeps at least one.' },
    { key: 'beamWidth', label: 'Plans carried', type: 'int', default: DEFAULT_BEAM_WIDTH, min: 50, max: 5000, step: 50, help: 'How many partial plans each search keeps.' },
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
      perEntry[entry.id] = pick ? [pick] : [];
      out.push({
        entry: entry.id,
        candidate: pick,
        reasoning: reasoning[entry.id],
        factors: pick ? [{
          label: 'Win probability',
          value: pick.winPct === null || pick.winPct === undefined ? null : `${pick.winPct.toFixed(1)}%`,
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
