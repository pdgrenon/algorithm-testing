/**
 * A finished week is never the answer to "which week is it".
 *
 * ESPN's scoreboard, asked for no week, keeps reporting a week as current for
 * a day or two after its last game is final. The front page then showed week
 * 4 on a Tuesday with every game over -- "Board closed" and "No legal pick"
 * for both entries -- while week 5 did not kick off until Thursday. And the
 * response was cached for a day, so it outlived ESPN's own rollover.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet as week } from '../deadpool/functions/api/week.js';

const team = (id, abbreviation) => ({ id, abbreviation, displayName: abbreviation, shortDisplayName: abbreviation });

const event = (id, date, state, weekNumber) => ({
  id, date, status: { type: { state } },
  week: { number: weekNumber }, season: { year: 2026, type: 2 },
  competitions: [{
    id,
    competitors: [
      { homeAway: 'home', score: '0', team: team('1', 'SEA') },
      { homeAway: 'away', score: '0', team: team('2', 'NE') },
    ],
  }],
});

const board = (weekNumber, state, date) => ({
  season: { year: 2026, type: 2 },
  week: { number: weekNumber },
  events: [event(`40${weekNumber}`, date, state, weekNumber)],
});

/** Stub ESPN by URL: the scoreboard by its `week` query, everything else empty. */
async function call(url, scoreboards) {
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  globalThis.caches = undefined;
  const asked = [];
  globalThis.fetch = async (target) => {
    const u = new URL(String(target));
    if (!u.pathname.endsWith('/scoreboard')) return new Response('{}', { status: 200 });
    asked.push(u.search);
    const body = scoreboards(u.searchParams.get('week'));
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('', { status: 404 });
  };
  try {
    const res = await week({ request: new Request(url) });
    return { headers: res.headers, body: JSON.parse(await res.text()), asked };
  } finally {
    globalThis.fetch = realFetch;
    globalThis.caches = realCaches;
  }
}

const FINISHED = board(4, 'post', '2026-10-05T00:15Z');
const NEXT = board(5, 'pre', '2099-10-09T00:15Z');

test('the current week steps forward once every game in it is final', async () => {
  const { body, asked } = await call('https://x.test/api/week', (w) => (w === null ? FINISHED : w === '5' ? NEXT : null));
  assert.equal(body.week, 5);
  assert.equal(body.games[0].state, 'pre');
  assert.match(asked[1], /week=5/);
  assert.match(asked[1], /dates=2026/);
});

test('a week still being played is left alone', async () => {
  const live = board(4, 'in', '2026-10-05T00:15Z');
  const { body, asked } = await call('https://x.test/api/week', (w) => (w === null ? live : NEXT));
  assert.equal(body.week, 4);
  assert.equal(asked.length, 1, 'no second scoreboard request');
});

test('an explicitly requested week is served as asked, finished or not', async () => {
  // Settling results reads finished weeks by number; rolling those forward
  // would leave every pick pending.
  const { body, headers } = await call('https://x.test/api/week?season=2026&week=4', () => FINISHED);
  assert.equal(body.week, 4);
  assert.match(headers.get('Cache-Control'), /max-age=86400\b/, 'and a finished week by number keeps its long TTL');
});

test('if the next week is not available, the finished one is served -- briefly', async () => {
  const { body, headers } = await call('https://x.test/api/week', (w) => (w === null ? FINISHED : null));
  assert.equal(body.week, 4, 'a stale board beats a blank one');
  assert.match(headers.get('Cache-Control'), /max-age=900\b/,
    'not the day-long TTL, which kept a finished week on the front page past the rollover');
});

test('week 18 does not roll into a regular-season week 19', async () => {
  const last = board(18, 'post', '2027-01-10T00:15Z');
  const { body, asked } = await call('https://x.test/api/week', () => last);
  assert.equal(body.week, 18);
  assert.equal(asked.length, 1);
});
