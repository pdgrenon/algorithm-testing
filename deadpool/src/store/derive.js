/**
 * Everything about a season, worked out from the pick log.
 *
 * ── The rule this file exists to enforce ────────────────────────────────
 *
 * The log is the truth and nothing else is stored. Which teams are used, who
 * is still alive, how many strikes an entry has, what the season looked like —
 * all of it is derived here, every time it is asked for.
 *
 * survivor-picker stores the opposite: `used_teams_a.json` is a flat list of
 * abbreviations with no week and no outcome. That has two costs. The tool
 * cannot answer the only question a survivor pool asks, which is whether you
 * are still in it. And a correction means editing a derived list by hand,
 * where the app should be able to fix one pick and have everything follow.
 *
 * Deriving means a deleted, corrected or back-dated pick immediately corrects
 * the whole app, because there is no second copy to fall out of step with the
 * first. It is the same reason the sibling workout tracker replays its history
 * to decide what you lift next rather than storing a running weight.
 */

/** A pick's identity is its slot. One entry, one week, one pick — structurally. */
export const pickId = (season, week, entry) =>
  `${season}-${String(week).padStart(2, '0')}-${entry}`;

export const RESULTS = ['pending', 'win', 'loss', 'tie'];

/** Picks for one entry in one season, oldest week first. */
export const picksFor = (picks, entry, season) =>
  picks.filter((p) => p.entry === entry && p.season === season).sort((a, b) => a.week - b.week);

/**
 * The teams this entry has spent.
 *
 * Includes a pick whose result is still pending: the team is burned the moment
 * it is picked, not when the game finishes. Getting that wrong would offer the
 * same team twice on a Sunday morning before any result exists.
 */
export const usedTeams = (picks, entry, season) =>
  picksFor(picks, entry, season).map((p) => p.team);

/**
 * What a finished game says about a pick, or `null` if it does not say yet.
 *
 * A port of `_resolve_pick_result` in pick_history.py, and deliberately the
 * same order of tests, because one of them is subtle enough to invert an
 * answer: **the tie is checked before `winner`**. ESPN sends `winner: false`
 * on *both* sides of a tie, so reading that field first scores a tie as a
 * loss — which in this pool, where a tie advances you, is the difference
 * between still being in it and being told you are out.
 *
 * Returns `null` rather than `'pending'` for everything it cannot settle: a
 * game still to be played, one in progress, one absent from the payload, a
 * pick with no team. The caller wants "leave this alone", and `'pending'` is a
 * value it would have to write.
 *
 * A live game is deliberately not settled from the score. ESPN publishes a
 * running score from the first snap, so a team ahead at half time reads
 * exactly like a team that won; only `state === 'post'` means the result is
 * final. This is the one check that stops a Sunday afternoon marking a pick
 * a win and an evening turning it into a loss.
 */
export function resolveResult(pick, games) {
  if (!pick?.team || !Array.isArray(games)) return null;

  for (const game of games) {
    // By event where the pick carries one — the score is per game, and a team
    // on a bye that somehow reached the log must not match a stale row. Falling
    // back to the team abbreviation covers a pick recorded before eventIds were
    // stored, and picks imported from the terminal tool, which stores neither.
    const byId = pick.eventId && game.eventId;
    if (byId && String(game.eventId) !== String(pick.eventId)) continue;

    // No event id on one side or the other, so the abbreviation is the only
    // join left — and an abbreviation is not unique across an array of games.
    // A team plays every week, so the same team's row in *some other week*
    // matches just as well, and `settlePending` deliberately hands this the
    // live week flattened together with every cached week that holds a pending
    // pick. Live week first, so the wrong row is the one it reaches first.
    //
    // The event id was carrying this on its own. Where it is absent — a pick
    // recorded before ids were stored, or imported from the terminal tool,
    // which stores neither — fall back to the week and season the pick was
    // made in. Both are on every parsed game from both sources.
    if (!byId) {
      if (game.week != null && pick.week != null && Number(game.week) !== Number(pick.week)) continue;
      if (game.seasonYear != null && pick.season != null && Number(game.seasonYear) !== Number(pick.season)) continue;
    }

    for (const [mine, theirs] of [[game.home, game.away], [game.away, game.home]]) {
      if (!mine || mine.abbreviation !== pick.team) continue;
      if (game.state !== 'post') return null;

      const ours = mine.score;
      const theirsScore = theirs?.score;
      if (ours !== null && ours !== undefined && theirsScore !== null && theirsScore !== undefined && ours === theirsScore) {
        return 'tie';
      }
      if (mine.winner === true) return 'win';
      if (mine.winner === false) return 'loss';
      return null;               // finished, and the source will not say who won
    }
  }
  return null;
}

/**
 * Every pending pick a payload can settle, as `{ id, result }`.
 *
 * Only `pending` is considered, which is the whole safety property: a result
 * somebody typed is never overwritten by one of these. Somebody correcting the
 * app is correcting it because they know something it does not — a pool ruling
 * a game differently, a sheet that disagrees — and an automatic pass that
 * quietly reverted them would make the app unusable exactly for the person
 * paying closest attention.
 */
export function settleable(picks, games) {
  const out = [];
  for (const pick of picks) {
    if (pick.result !== 'pending') continue;
    const result = resolveResult(pick, games);
    if (result) out.push({ id: pick.id, result });
  }
  return out;
}

/**
 * Whether an entry is still in, and what it has cost so far.
 *
 * `strikesAllowed` is 1 in a classic pool — one loss and you are out — but
 * two-strike pools are common enough to be a setting rather than an
 * assumption.
 *
 * A tie is *not* a loss by default, which is the opposite of the near-universal
 * assumption in survivor writing and is confirmed for this pool. Every other
 * default in the repository agrees -- `defaultState()` next door,
 * `DEFAULT_TIE_IS_LOSS` in both engines, `TIE_IS_LOSS` in config.py -- and
 * `outcome_for` scores a tie as a win for both sides when replaying real
 * seasons. Pools that rule the other way pass it, which is why it is a
 * parameter rather than a constant.
 */
export function statusOf(picks, entry, season, { strikesAllowed = 1, tieIsLoss = false } = {}) {
  const mine = picksFor(picks, entry, season);
  let strikes = 0;
  let eliminatedWeek = null;

  for (const p of mine) {
    const lost = p.result === 'loss' || (p.result === 'tie' && tieIsLoss);
    if (!lost) continue;
    strikes += 1;
    if (strikes >= strikesAllowed && eliminatedWeek === null) eliminatedWeek = p.week;
  }

  const wins = mine.filter((p) => p.result === 'win').length;
  const pending = mine.filter((p) => p.result === 'pending').length;

  return {
    alive: eliminatedWeek === null,
    eliminatedWeek,
    strikes,
    strikesAllowed,
    survived: wins,
    pending,
    played: mine.length,
    lastPick: mine.length ? mine[mine.length - 1] : null,
    // A record reads "5-0" and everyone knows what it means; a pending week is
    // not a result and is deliberately not counted into it.
    record: `${wins}-${strikes}`,
  };
}

/** The pick an entry made in one week, or null. */
export const pickAt = (picks, entry, season, week) =>
  picks.find((p) => p.entry === entry && p.season === season && p.week === week) ?? null;

/** Every week of a season, with each entry's pick — the Season screen's data. */
export function timeline(picks, season, entries, weeks = 18) {
  const rows = [];
  for (let week = 1; week <= weeks; week += 1) {
    const cells = entries.map((e) => ({ entry: e.id, pick: pickAt(picks, e.id, season, week) }));
    if (cells.every((c) => c.pick === null)) continue;
    rows.push({ week, cells });
  }
  return rows;
}

/**
 * Board state per team, for one entry.
 *
 * Four states, and they are the four questions somebody actually has in front
 * of a board: have I spent this, can I take it this week, is it even playing,
 * and did it already kick off.
 */
export function boardFor(picks, entry, season, weekGames, allAbbrs) {
  const used = new Map(picksFor(picks, entry, season).map((p) => [p.team, p]));
  const playing = new Map();
  for (const g of weekGames) {
    for (const [t, o] of [[g.home, g.away], [g.away, g.home]]) {
      if (t.abbreviation) playing.set(t.abbreviation, { opponent: o.abbreviation, state: g.state, startDate: g.startDate, eventId: g.eventId });
    }
  }
  return allAbbrs.map((abbr) => {
    const spent = used.get(abbr) ?? null;
    const game = playing.get(abbr) ?? null;
    let state;
    if (spent) state = 'used';
    else if (!game) state = 'bye';
    else if (game.state && game.state !== 'pre') state = 'started';
    else state = 'available';
    return { abbr, state, pick: spent, game };
  });
}

/**
 * A one-line summary of both entries, for the top of the Week screen.
 *
 * This is the headline the whole app is organised around, and the terminal
 * tool has no equivalent of it because it never knew an outcome.
 */
export function headline(picks, season, entries, week, options) {
  const statuses = entries.map((e) => ({ entry: e, status: statusOf(picks, e.id, season, options) }));
  const alive = statuses.filter((s) => s.status.alive);
  return {
    statuses,
    aliveCount: alive.length,
    total: statuses.length,
    allOut: alive.length === 0,
    // "Both" only where there are two of them. The all-alive branch already
    // took that care and the all-out branch did not, so a third entry -- which
    // arrives through an imported backup rather than through the interface --
    // would have read "Both out" over three dead ones.
    text: alive.length === statuses.length
      ? (statuses.length === 2 ? 'Both alive' : `${alive.length} alive`)
      : alive.length === 0
        ? (statuses.length === 2 ? 'Both out' : 'All out')
        : `${alive.map((s) => s.entry.name).join(', ')} still alive`,
    week,
  };
}
