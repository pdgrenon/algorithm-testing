/**
 * The rules every strategy has to obey, in one place.
 *
 * In the Python each of the four strategies re-implements these: not already
 * used, not the same team twice, not two teams from one game, not a game that
 * has kicked off. Four implementations of one rule is four chances to get one
 * of them subtly wrong, and three of those four were unreachable from the CLI
 * so nobody would have found out.
 *
 * Hoisting them does two things. A new strategy gets them for free and cannot
 * skip one by accident. And — the part that shows up in the interface — the
 * reason an option is unavailable becomes a value rather than a `continue`,
 * so the app can say "SEA/ARI kicked off at 1:00" instead of silently
 * shrinking the list under somebody's thumb.
 *
 * Nothing here changes what any strategy decides. `buildOptions` walks games
 * and sides in exactly the order the Python does — home before away, games in
 * payload order — because every ranking below it is a stable sort and the
 * input order is therefore part of the answer.
 */

import { resolveTeamWinProbability } from './win-prob.js';

/** The only game state a pick may be made in. */
export const PICKABLE_STATE = 'pre';

export const REASON = {
  STARTED: 'started',
  USED: 'used',
  SAME_GAME: 'same-game',
  SAME_TEAM: 'same-team',
  BELOW_FLOOR: 'below-floor',
  NO_DATA: 'no-data',
};

/**
 * Whether this game can still be picked.
 *
 * A null state is treated as pickable, matching `if game.state and game.state
 * != "pre"` — an unknown state is not the same as a started one, and refusing
 * on unknown would delete a whole week the first time ESPN renamed a field.
 */
export const isPickable = (game) => !game.state || game.state === PICKABLE_STATE;

/**
 * Every team playing a still-pickable game this week, with its resolved
 * probability, in Python's iteration order.
 *
 * Deliberately does NOT filter used teams: `joint_optimizer.build_team_options`
 * does not either, and the two entries have different used lists, so the filter
 * belongs to the caller.
 */
export function buildOptions(games) {
  const options = [];
  for (const game of games) {
    if (!isPickable(game)) continue;
    const spreadDetail = game.odds ? game.odds.details : null;
    for (const [team, opponent, isHome] of [
      [game.home, game.away, true],
      [game.away, game.home, false],
    ]) {
      if (!team.abbreviation) continue;
      const resolved = resolveTeamWinProbability(game, isHome);
      options.push({
        teamAbbreviation: team.abbreviation,
        teamName: team.displayName,
        opponentAbbreviation: opponent.abbreviation,
        eventId: game.eventId,
        isHome,
        startDate: game.startDate,
        winPct: resolved.winPct,
        winPctSource: resolved.source,
        spreadDetail,
      });
    }
  }
  return options;
}

/**
 * The teams that would have been options but for a game already under way.
 *
 * Nothing in the engine reads this. It exists so the interface can account for
 * a list that got shorter — which the Python does correctly and invisibly.
 */
export function unavailableOptions(games) {
  const out = [];
  for (const game of games) {
    if (isPickable(game)) continue;
    for (const [team, opponent] of [[game.home, game.away], [game.away, game.home]]) {
      if (!team.abbreviation) continue;
      out.push({
        teamAbbreviation: team.abbreviation,
        opponentAbbreviation: opponent.abbreviation,
        eventId: game.eventId,
        startDate: game.startDate,
        reason: REASON.STARTED,
        state: game.state,
      });
    }
  }
  return out;
}

/** Options this entry has not already spent. */
export const notUsed = (options, usedTeams) =>
  options.filter((o) => !usedTeams.includes(o.teamAbbreviation));

/**
 * The event two teams would both be picked out of, if it is the same one.
 *
 * The event id answers this whenever there is one. Where there is not, the
 * opponents do: two options are opposite sides of one game exactly when each
 * names the other as its opponent. Both fields are built together in
 * `buildOptions`, so an option carrying one carries the other.
 *
 * The id alone used to be the whole test, which fails *open* — a null id on
 * either side returned false, and `joint`'s pair search read that as "these
 * are different games". That is the one guarantee the strategy is named for,
 * and `buildReasoning` prints "Different games …, so one result cannot end
 * both" without re-checking, so the failure arrives with a sentence asserting
 * the opposite. `scorePair` mis-scores it too, computing (1-pA)(1-pB) for an
 * outcome whose real probability is zero.
 *
 * ESPN has always sent `event.id`, so this is not a bug anyone has hit. It is
 * the degradation `safeGet` exists to survive: a renamed field becomes `null`
 * rather than a crash, and every guard downstream is supposed to hold when it
 * does.
 */
export const sameGame = (a, b) => {
  if (a.eventId !== null && a.eventId !== undefined && b.eventId !== null && b.eventId !== undefined) {
    return a.eventId === b.eventId;
  }
  return (a.opponentAbbreviation != null && a.opponentAbbreviation === b.teamAbbreviation)
    || (b.opponentAbbreviation != null && b.opponentAbbreviation === a.teamAbbreviation);
};

export const sameTeam = (a, b) => a.teamAbbreviation === b.teamAbbreviation;

/**
 * Rank by win probability, highest first, with no-data last.
 *
 * This is `sort(key=lambda c: (c.win_pct is None, -(c.win_pct or 0)))` and the
 * tuple matters in both halves: `False < True` puts scored candidates ahead of
 * unscored ones, and the sort is stable in both languages so equal
 * probabilities keep their input order. Neither of those is incidental — they
 * decide the answer whenever two teams are level, which on a spread-derived
 * board is most weeks.
 */
export function byWinPctDesc(a, b) {
  const an = a.winPct === null || a.winPct === undefined;
  const bn = b.winPct === null || b.winPct === undefined;
  if (an !== bn) return an ? 1 : -1;
  return -(a.winPct || 0) - -(b.winPct || 0);
}

/**
 * The recommendation, then the rest of the board behind it, best first.
 *
 * **The contract the picker's override depends on.** week.js renders
 * "Pick something else" as `candidates[entry].slice(1, 9)` -- index 0 is
 * dropped because it is the recommendation already on screen above. So
 * `candidates[entry][0]` MUST be the pick, and the rest must exclude it.
 *
 * Lives here, in one place, because all three strategies that build a board
 * got it wrong in two different ways. `distinct` and `leverage` returned a
 * one-element array, so the slice was empty and the override rendered as
 * nothing at all -- shipped the moment `distinct` became the default, having
 * been latent since it was written. `joint` returned the full board sorted by
 * win probability, which is not the same as pick-first: its recommendation is
 * the best *pair*, often not the best single team, so the view dropped an
 * arbitrary team and listed the recommendation as an alternative to itself.
 *
 * Teams the entry has spent are removed. Teams whose game has kicked off stay:
 * the view disables them with the reason attached, which is more use than a
 * team vanishing with no explanation.
 */
export function boardBehind(pick, games, used) {
  const rest = buildOptions(games)
    .filter((o) => !used.includes(o.teamAbbreviation))
    .filter((o) => !pick || o.teamAbbreviation !== pick.teamAbbreviation)
    .sort(byWinPctDesc);
  return pick ? [pick, ...rest] : rest;
}


/** The same ordering, over a `score` field rather than `winPct`. */
export function byScoreDesc(a, b) {
  const an = a.score === null || a.score === undefined;
  const bn = b.score === null || b.score === undefined;
  if (an !== bn) return an ? 1 : -1;
  return -(a.score || 0) - -(b.score || 0);
}

/** Lexicographic, matching Python's string comparison for ASCII abbreviations. */
export const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
