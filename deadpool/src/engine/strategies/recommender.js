/**
 * Rank every not-yet-used team by win probability. The simple one.
 *
 * Port of `picker/recommender.py`, unchanged. This is the only
 * strategy the Python CLI could actually run — `main.py` imports this module
 * and nothing else — so it is the behaviour anyone who has used the terminal
 * tool has actually seen, and it is here as the baseline the others are
 * measured against rather than as the default.
 *
 * It reasons about one entry at a time and knows nothing about the other, so
 * it will happily hand both entries the same team. `findConflicts` is the
 * whole of its answer to that: a heads-up, after the fact.
 */

import { buildOptions, notUsed, byWinPctDesc, modelFieldsOf } from '../constraints.js';
import { f1 } from '../fmt.js';

export const ID = 'ranked';

const toCandidate = (o) => ({
  teamAbbreviation: o.teamAbbreviation,
  teamName: o.teamName,
  opponentAbbreviation: o.opponentAbbreviation,
  winPct: o.winPct,
  winPctIsEstimated: o.winPctSource === 'spread_estimate',
  winPctSource: o.winPctSource,
  spreadDetail: o.spreadDetail,
  eventId: o.eventId,
  startDate: o.startDate,
  ...modelFieldsOf(o),
});

/**
 * All not-yet-used teams playing this week, best first.
 *
 * Teams with no probability at all sort last rather than being dropped: there
 * is no basis to recommend one over a team we can score, and no basis to
 * pretend it is not playing either.
 */
export function rankCandidates(games, usedTeams, modelOpts = {}) {
  return notUsed(buildOptions(games, modelOpts), usedTeams)
    .map(toCandidate)
    .sort(byWinPctDesc);
}

/**
 * The top `topN` for each entry.
 *
 * Each entry ranks against its own used-teams history, because A and B can
 * have burned different teams in past weeks.
 */
export function recommendForEntries(games, usedTeamsByEntry, topN = 5) {
  const out = {};
  for (const [entry, used] of Object.entries(usedTeamsByEntry)) {
    out[entry] = rankCandidates(games, used).slice(0, topN);
  }
  return out;
}

/**
 * The team every entry's #1 lands on, if they all land on the same one.
 *
 * Null when the entries disagree, which is the healthy case.
 */
export function findConflicts(recommendations) {
  const tops = Object.values(recommendations)
    .filter((c) => c.length)
    .map((c) => c[0].teamAbbreviation);
  if (tops.length > 1 && new Set(tops).size === 1) return tops[0];
  return null;
}

const describe = (c) => {
  const winPct = c.winPct === null || c.winPct === undefined ? 'unknown' : `${f1(c.winPct)}%`;
  const basis = c.winPctIsEstimated ? ' (estimated from spread)' : '';
  const spread = c.spreadDetail ? `, spread ${c.spreadDetail}` : '';
  return `${c.teamAbbreviation} vs ${c.opponentAbbreviation || '?'} -- ${winPct} win prob${basis}${spread}`;
};

/* ------------------------------------------------ the registry contract -- */

export default {
  id: ID,
  name: 'Most likely to win',
  blurb: 'Takes the safest team on the board, out of the ones you have not used yet. '
    + 'Nothing else — no thought about later weeks, and no coordination between your two entries.',
  entries: 'single',
  params: [
    { key: 'topN', label: 'Alternatives to keep', type: 'int', default: 5, min: 1, max: 32, help: 'How far down the ranking to carry into the interface.' },
  ],

  run(ctx) {
    const topN = ctx.params.topN ?? 5;
    const perEntry = {};
    const picks = [];

    for (const entry of ctx.entries) {
      const ranked = rankCandidates(ctx.games, ctx.usedTeams[entry.id] ?? [], ctx.modelOpts);
      perEntry[entry.id] = ranked.slice(0, topN);
      const top = ranked[0] ?? null;
      picks.push({
        entry: entry.id,
        candidate: top,
        factors: top ? [
          { label: 'Win probability', value: top.winPct === null ? null : `${f1(top.winPct)}%`, weight: 1, note: top.winPctIsEstimated ? 'Estimated from the spread — ESPN has not published a probability yet.' : 'From ESPN.' },
          { label: 'Spread', value: top.spreadDetail ?? null, weight: 0 },
        ] : [],
        reasoning: top ? `Top pick: ${describe(top)}.` : 'No eligible teams available this week (all used, or no game data).',
      });
    }

    const conflict = findConflicts(perEntry);
    return {
      strategyId: ID,
      picks,
      candidates: perEntry,
      considered: Object.values(perEntry).reduce((n, c) => n + c.length, 0),
      warnings: conflict
        ? [{ level: 'warn', text: `Both entries' top pick is ${conflict}. One result would eliminate both — consider taking the runner-up for one of them.` }]
        : [],
    };
  },
};
