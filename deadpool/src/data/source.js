/**
 * Where the games come from, and what to say when they are stale.
 *
 * Cache first, always. The app renders from whatever it last saw before any
 * request goes out, so opening it on a phone with one bar shows the board
 * immediately rather than a spinner over the one screen that matters. The
 * network answer replaces it in place when it lands.
 *
 * Every payload carries `source`, and the interface prints it. This is the
 * rule the whole design leans on: an app quietly showing Thursday's numbers on
 * a Sunday is worse than one that admits it is offline, because the first
 * looks exactly like working.
 *
 *   live      just fetched
 *   cache     from this device, with the time it was fetched
 *   offline   the fetch failed and this is the last thing we have
 *   none      nothing cached and nothing reachable
 *
 * `source` is *freshness* and nothing else. Which upstream answered is a
 * second, independent fact — the endpoint falls back to nflverse when ESPN
 * refuses, and that board carries the schedule and the closing line but no
 * live model and no kickoff state. The two came apart the moment a fallback
 * board was cached: folded into one enum, reading it back turned it into a
 * plain "cache" and the app stopped saying the odds were not live. So it
 * travels beside it, as `upstream`, and survives the round trip.
 */

import * as store from '../store/index.js';

const API = '/api';

/**
 * Season fetches are heavy and rarely change, so each is made once and shared.
 *
 * Keyed by season, which one shared promise was not. An installed app stays
 * alive across a January and `refresh()` runs on every return to the tab, so
 * the first request after the rollover was answered with the promise still
 * holding last year's schedule -- and no fetch for the new one was ever made.
 * That schedule is what `scheduleGames` feeds the lookahead, so every future
 * matchup the strategies reasoned about was from the wrong season.
 *
 * A failure is deliberately not remembered. `refresh()` comes back, and one
 * blip at startup must not leave the lookahead thin for the whole session.
 */
const seasonPromises = new Map();

function fetchSeasonOnce(season) {
  const held = seasonPromises.get(season);
  if (held) return held;
  const attempt = refreshSeason(season);
  seasonPromises.set(season, attempt);
  attempt.catch(() => {
    if (seasonPromises.get(season) === attempt) seasonPromises.delete(season);
  });
  return attempt;
}

async function getJson(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status}`);
  const body = await res.json();
  if (body.ok === false) throw new Error(body.error || 'upstream');
  return body;
}

/**
 * One week, cache-first with a network refresh behind it.
 *
 * `onUpdate` is called a second time if the network produces something newer.
 * Two calls rather than one await, because the whole point is that the first
 * paint does not wait for the network.
 */
export async function loadWeek({ season, week } = {}, onUpdate = () => {}) {
  const pointer = store.readCache('current', season ?? store.getSeason());
  const wantSeason = season ?? pointer?.season ?? store.getSeason();
  const wantWeek = week ?? pointer?.week ?? null;

  const cached = wantWeek ? store.readCache('week', wantSeason, wantWeek) : null;
  if (cached) {
    onUpdate({ ...cached, source: 'cache', fetchedAt: cached.fetchedAt ?? cached.cachedAt });
  }

  try {
    const query = new URLSearchParams();
    if (season) query.set('season', String(season));
    if (week) query.set('week', String(week));
    const fresh = await getJson(`${API}/week${query.toString() ? `?${query}` : ''}`);

    store.writeCache('week', fresh.season, fresh.week, fresh);
    // Remember which week is current, so a later cold start with no network
    // still knows what to show rather than guessing from a clock. Either
    // source can answer this: ESPN says so outright, and the fallback derives
    // it from the schedule.
    store.writeCache('current', fresh.season, null, { season: fresh.season, week: fresh.week });

    const payload = { ...fresh, source: 'live' };
    onUpdate(payload);
    return payload;
  } catch (err) {
    const payload = cached
      ? { ...cached, source: 'offline', fetchedAt: cached.fetchedAt ?? cached.cachedAt }
      : { ok: false, games: [], season: wantSeason, week: wantWeek, source: 'none', error: String(err.message || err) };
    onUpdate(payload);
    return payload;
  }
}

/**
 * The season schedule, which is what makes the lookahead real.
 *
 * Everything downstream works without it — the strategies handle an absent
 * schedule by degenerating, exactly as the Python always did — so this never
 * blocks a render and a failure is not an error, just a thinner answer.
 */
export async function loadSeason(season = store.getSeason()) {
  const cached = store.readCache('season', season);
  if (cached) {
    // Refresh in the background: a schedule barely changes, and the copy in
    // hand is good enough to reason with while a newer one is on its way.
    fetchSeasonOnce(season).catch(() => null);
    return { ...cached, source: 'cache' };
  }
  try {
    return await fetchSeasonOnce(season);
  } catch {
    return null;
  }
}

async function refreshSeason(season) {
  const fresh = await getJson(`${API}/season?season=${season}`);
  store.writeCache('season', season, null, fresh);
  return { ...fresh, source: 'live' };
}

/**
 * The pool's own pick sheet — the field, as opposed to the games.
 *
 * Cache-first like the others, and for a stronger reason than either: this
 * changes at most once a week. A sheet fetched on Monday is still exactly
 * right on Saturday, because the thing it records — what everybody picked in
 * weeks that have already kicked off — cannot change retroactively.
 *
 * `getJson` throws on `ok === false`, which is right for /api/week and wrong
 * here. Three of this endpoint's four answers are *not* errors and each needs
 * its own sentence on screen:
 *
 *   configured: false   no sheet set for this deployment. Draw nothing.
 *   ok: false           a sheet is set and did not come back. Say which way.
 *   ok: true            a sheet, parsed, possibly with problems in it.
 *
 * Collapsing those into a thrown error is exactly the failure /api/pool's own
 * header warns about: an unshared sheet answers 200 with a sign-in page, and
 * the one outcome worth engineering against is that reaching the app as
 * "empty pool" rather than "you have not shared the sheet". So this reads the
 * body itself rather than going through `getJson`.
 */
export async function loadPool(season = store.getSeason(), onUpdate = () => {}) {
  const cached = store.readCache('pool', season);
  if (cached) onUpdate({ ...cached, source: 'cache', fetchedAt: cached.fetchedAt ?? cached.cachedAt });

  try {
    const res = await fetch(`${API}/pool`, { headers: { Accept: 'application/json' } });
    const body = await res.json();

    // Only a sheet that actually parsed is worth caching. Caching a failure
    // would put "the sheet is unreachable" on screen for as long as the cache
    // lives, including after it had been fixed.
    if (body && body.ok) store.writeCache('pool', season, null, body);

    const payload = { ...body, source: 'live' };
    onUpdate(payload);
    return payload;
  } catch (err) {
    const payload = cached
      ? { ...cached, source: 'offline', fetchedAt: cached.fetchedAt ?? cached.cachedAt }
      : { configured: null, ok: false, error: 'unreachable', detail: String(err.message || err), source: 'none' };
    onUpdate(payload);
    return payload;
  }
}

/**
 * What to say about the sheet, in the app's own words.
 *
 * Separate from `describeSource` because the two answer different questions.
 * That one is about freshness of a board that definitely exists; this one is
 * mostly about whether a sheet exists at all, which is the state nearly every
 * deployment is in.
 */
export function describePool(payload) {
  if (!payload) return { tone: 'offline', text: 'The pool sheet has not been read yet' };
  if (payload.configured === false) {
    return { tone: 'offline', text: 'No pool sheet is configured for this deployment' };
  }
  if (payload.ok === false) {
    const reason = payload.error === 'not-csv'
      ? 'the sheet is not readable without signing in'
      : payload.error === 'upstream' ? `the sheet answered ${payload.status ?? 'an error'}`
        : 'the sheet could not be reached';
    return { tone: 'offline', text: `Pool sheet unavailable — ${reason}` };
  }
  const at = payload.fetchedAt ? new Date(payload.fetchedAt) : null;
  const when = at ? at.toLocaleDateString([], { day: 'numeric', month: 'short' }) : 'an unknown time';
  if (payload.source === 'offline') return { tone: 'offline', text: `Offline — sheet as of ${when}` };
  return { tone: payload.source === 'live' ? 'live' : 'cache', text: `Sheet as of ${when}` };
}

/** Every game across every loaded week, for buildWinProbabilityTable. */
export function scheduleGames(seasonPayload) {
  if (!seasonPayload || !seasonPayload.weeks) return null;
  return Object.keys(seasonPayload.weeks)
    .map(Number)
    .sort((a, b) => a - b)
    .flatMap((w) => seasonPayload.weeks[w]);
}

/** How to describe the provenance, in the app's own words. */
export function describeSource(payload) {
  if (!payload) return { tone: 'offline', text: 'No game data' };
  const at = payload.fetchedAt ? new Date(payload.fetchedAt) : null;
  const when = at ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'an unknown time';
  const day = at && !isToday(at) ? at.toLocaleDateString([], { weekday: 'short' }) : null;
  const stamp = day ? `${day} ${when}` : when;

  // Which numbers these are, before how old they are. A fallback board is
  // real and usable -- the fixtures and the market price are all a pick needs
  // -- but the live model and the kickoff state are absent, and an app calling
  // that "Odds" is the quiet wrongness this whole file exists to avoid.
  // Amber rather than a fourth colour: the dot has three states and the
  // sentence carries the distinction.
  const fallback = payload.upstream === 'nflverse';
  const what = fallback ? 'Closing line' : 'Odds';

  if (payload.source === 'live') {
    return fallback
      ? { tone: 'cache', text: `${what} as of ${stamp} — ESPN unavailable` }
      : { tone: 'live', text: `Odds as of ${stamp}` };
  }
  if (payload.source === 'cache') return { tone: 'cache', text: `${what} as of ${stamp}` };
  if (payload.source === 'offline') return { tone: 'offline', text: `Offline — showing ${stamp}` };
  return { tone: 'offline', text: 'No game data on this device yet' };
}

const isToday = (d) => {
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};

/**
 * When the first pick on the board locks, and how long that is.
 *
 * Per game, not per week: a pick's window closes at its own kickoff, and the
 * Python drops a started game silently rather than warning that the next one
 * is twenty minutes out. Returns null when there is nothing left to lock.
 */
export function nextLock(games, now = Date.now()) {
  const upcoming = games
    .filter((g) => (!g.state || g.state === 'pre') && g.startDate)
    .map((g) => ({ at: Date.parse(g.startDate), game: g }))
    .filter((x) => Number.isFinite(x.at) && x.at > now)
    .sort((a, b) => a.at - b.at);
  if (!upcoming.length) return null;

  const first = upcoming[0];
  return { at: first.at, in: first.at - now, game: first.game, remaining: upcoming.length };
}

/**
 * How long until a lock, in the unit that is useful at that distance.
 *
 * A countdown is what somebody wants inside a day; "32d 21h" is a number
 * nobody is acting on and it wraps onto two lines to say so. Past two days the
 * answer is a date, which is both shorter and the thing actually being asked.
 */
export function formatCountdown(ms, at = null) {
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  if (hours < 48) return 'tomorrow';
  return at ? new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' }) : `${Math.floor(hours / 24)}d`;
}
