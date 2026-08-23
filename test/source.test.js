/**
 * Where the games come from: the cache-first read, and the memo behind it.
 *
 * This file had no coverage at all, which is how a season-long memo keyed by
 * nothing survived. The first two groups are about that memo; the rest pin the
 * parts of the module the interface reads directly, because "Odds" over a
 * fallback board is the exact wrongness source.js says it exists to prevent.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage } from './helpers/local-storage.js';
import * as store from '../deadpool/src/store/index.js';

beforeEach(() => {
  installLocalStorage();
  store.load();          // the store module is shared; reload it onto the new backing
});

/** source.js keeps module state, so each test gets its own copy. */
async function freshSource() {
  const url = new URL('../deadpool/src/data/source.js', import.meta.url);
  return import(`${url.href}?t=${Math.random()}`);
}

const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });

/** Records every path asked for, and answers with whatever `handler` returns. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push(String(path));
    return handler(String(path), init);
  };
  return calls;
}

const seasonOf = (path) => Number(new URL(path, 'http://x').searchParams.get('season'));

/* ------------------------------------------------------- the season memo -- */

test('a season fetch is shared only with the season it was for', async () => {
  const calls = stubFetch(async (path) => {
    const season = seasonOf(path);
    return jsonRes({ ok: true, season, weeks: { 1: [{ eventId: `g-${season}` }] } });
  });
  const src = await freshSource();

  assert.equal((await src.loadSeason(2025)).season, 2025);

  const next = await src.loadSeason(2026);
  assert.equal(next.season, 2026,
    'an installed app is alive across a January, and the lookahead must not be built from last season');
  assert.equal(next.weeks[1][0].eventId, 'g-2026');
  assert.deepEqual(calls.map(seasonOf), [2025, 2026], 'and the new season is actually asked for');
});

test('one season is still only fetched once', async () => {
  const calls = stubFetch(async (path) => jsonRes({ ok: true, season: seasonOf(path), weeks: {} }));
  const src = await freshSource();

  await src.loadSeason(2026);
  const again = await src.loadSeason(2026);
  assert.equal(again.source, 'cache', 'the second read comes off the device');
  assert.equal(calls.length, 1, 'a schedule barely changes; twice a session is waste');
});

test('a season fetch that failed is tried again, not remembered as failed', async () => {
  let online = false;
  const calls = stubFetch(async (path) => {
    if (!online) throw new Error('network down');
    return jsonRes({ ok: true, season: seasonOf(path), weeks: { 1: [] } });
  });
  const src = await freshSource();

  assert.equal(await src.loadSeason(2026), null, 'a thin answer, not an error');
  online = true;
  const recovered = await src.loadSeason(2026);
  assert.ok(recovered, 'refresh() runs on every return to the tab; one blip must not last the session');
  assert.equal(recovered.season, 2026);
  assert.equal(calls.length, 2);
});

/* --------------------------------------------------------------- a week -- */

test('the cached week paints first, and the live one replaces it', async () => {
  stubFetch(async () => jsonRes({ ok: true, season: 2026, week: 3, games: [{ eventId: 'live' }] }));
  store.writeCache('week', 2026, 3, { ok: true, season: 2026, week: 3, games: [{ eventId: 'old' }] });
  store.writeCache('current', 2026, null, { season: 2026, week: 3 });
  const src = await freshSource();

  const seen = [];
  const final = await src.loadWeek({}, (p) => seen.push([p.source, p.games[0].eventId]));
  assert.deepEqual(seen, [['cache', 'old'], ['live', 'live']],
    'the board is on screen before the request goes out');
  assert.equal(final.source, 'live');
});

test('a week that cannot be fetched says offline rather than showing nothing', async () => {
  stubFetch(async () => { throw new Error('down'); });
  store.writeCache('week', 2026, 3, { ok: true, season: 2026, week: 3, games: [{ eventId: 'old' }] });
  store.writeCache('current', 2026, null, { season: 2026, week: 3 });
  const src = await freshSource();

  const payload = await src.loadWeek({});
  assert.equal(payload.source, 'offline');
  assert.equal(payload.games[0].eventId, 'old');
});

test('with nothing cached and nothing reachable, the answer is none', async () => {
  stubFetch(async () => { throw new Error('down'); });
  const src = await freshSource();

  const payload = await src.loadWeek({ season: 2026, week: 3 });
  assert.equal(payload.source, 'none');
  assert.deepEqual(payload.games, []);
  assert.equal(payload.ok, false);
});

/* ------------------------------------------------------- what it is told -- */

test('a fallback board is called a closing line, not odds', async () => {
  const src = await freshSource();
  const at = new Date().toISOString();
  assert.match(src.describeSource({ source: 'live', upstream: 'nflverse', fetchedAt: at }).text,
    /^Closing line as of .* — ESPN unavailable$/);
  assert.match(src.describeSource({ source: 'live', upstream: 'espn', fetchedAt: at }).text, /^Odds as of /);
  assert.equal(src.describeSource({ source: 'live', upstream: 'espn', fetchedAt: at }).tone, 'live');
  assert.equal(src.describeSource({ source: 'live', upstream: 'nflverse', fetchedAt: at }).tone, 'cache',
    'a board with no live model is not a live board, whatever the dot has room to say');
});

test('a cached fallback board keeps saying it is a closing line', async () => {
  const src = await freshSource();
  // This is the round trip that folded the two facts into one: read back from
  // the device, freshness said "cache" and provenance said nothing at all.
  const text = src.describeSource({ source: 'cache', upstream: 'nflverse', fetchedAt: new Date().toISOString() }).text;
  assert.match(text, /^Closing line as of /);
});

/* ------------------------------------------------------------ the clock -- */

test('the next lock is the earliest kickoff still ahead, not the week', async () => {
  const src = await freshSource();
  const now = Date.parse('2026-09-13T16:00:00Z');
  const games = [
    { eventId: 'sun-late', state: 'pre', startDate: '2026-09-13T20:05:00Z' },
    { eventId: 'thu-done', state: 'post', startDate: '2026-09-10T00:20:00Z' },
    { eventId: 'sun-early', state: 'pre', startDate: '2026-09-13T17:00:00Z' },
    { eventId: 'kicked-off', state: 'in', startDate: '2026-09-13T16:30:00Z' },
    { eventId: 'no-date', state: 'pre', startDate: null },
  ];
  const lock = src.nextLock(games, now);
  assert.equal(lock.game.eventId, 'sun-early');
  assert.equal(lock.remaining, 2, 'only the two that are still pre and still ahead');
  assert.equal(lock.in, 3600_000);
});

test('nothing left to lock is null, not a countdown to nowhere', async () => {
  const src = await freshSource();
  const now = Date.parse('2026-09-13T23:00:00Z');
  assert.equal(src.nextLock([{ state: 'post', startDate: '2026-09-13T17:00:00Z' }], now), null);
  assert.equal(src.nextLock([], now), null);
});

test('a countdown is in the unit that is useful at that distance', async () => {
  const src = await freshSource();
  const min = 60_000;
  assert.equal(src.formatCountdown(0), 'now');
  assert.equal(src.formatCountdown(-5 * min), 'now');
  assert.equal(src.formatCountdown(45 * min), '45m');
  assert.equal(src.formatCountdown(59 * min), '59m');
  assert.equal(src.formatCountdown(90 * min), '1h 30m');
  assert.equal(src.formatCountdown(23 * 60 * min), '23h 0m');
  assert.equal(src.formatCountdown(30 * 60 * min), 'tomorrow');
  assert.equal(src.formatCountdown(72 * 60 * min, Date.parse('2026-09-16T17:00:00Z')).length > 0, true,
    'past two days it is a date, because "32d 21h" is not a number anyone acts on');
});

/* ---------------------------------------------------------- the schedule -- */

test('the season flattens into weeks in order, whatever order the keys came in', async () => {
  const src = await freshSource();
  const games = src.scheduleGames({ weeks: { 10: [{ w: 10 }], 2: [{ w: 2 }], 1: [{ w: 1 }] } });
  assert.deepEqual(games.map((g) => g.w), [1, 2, 10],
    'week 10 must not land between 1 and 2 -- integer-like keys happen to come back'
    + ' ascending, so the explicit sort is what makes that a guarantee rather than a habit');
  assert.equal(src.scheduleGames(null), null);
  assert.equal(src.scheduleGames({}), null);
});
