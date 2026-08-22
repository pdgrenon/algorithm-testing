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
 */

import * as store from '../store/index.js';

const API = '/api';

/** Season fetches are heavy and rarely change; once per session is plenty. */
let seasonPromise = null;

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
    // Remember which week ESPN considers current, so a later cold start with
    // no network still knows what to show rather than guessing from a clock.
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
    if (!seasonPromise) seasonPromise = refreshSeason(season).catch(() => null);
    return { ...cached, source: 'cache' };
  }
  if (!seasonPromise) seasonPromise = refreshSeason(season);
  try {
    return await seasonPromise;
  } catch {
    return null;
  }
}

async function refreshSeason(season) {
  const fresh = await getJson(`${API}/season?season=${season}`);
  store.writeCache('season', season, null, fresh);
  return { ...fresh, source: 'live' };
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

  if (payload.source === 'live') return { tone: 'live', text: `Odds as of ${stamp}` };
  if (payload.source === 'cache') return { tone: 'cache', text: `Odds as of ${stamp}` };
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
