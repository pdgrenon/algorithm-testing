/**
 * The app must not go blank when ESPN refuses.
 *
 * It did. Akamai began answering 403 to the edge Function's User-Agent while
 * the same URL returned 200 to curl from a laptop, and the front page said
 * "Nothing to show yet" -- not a stale board, not a warning, nothing. For a
 * product whose data is a public NFL schedule that is the wrong shape to be
 * in, and these are the tests that keep it from happening again.
 *
 * What is asserted is the whole ladder, in order: ESPN when it answers, the
 * second source when it does not, and an honest failure only when neither
 * has anything. The middle rung is the one that did not exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, existsSync } from 'node:fs';

import { onRequestGet as week } from '../deadpool/functions/api/week.js';
import { onRequestGet as season } from '../deadpool/functions/api/season.js';
import { buildWinProbabilityTable } from '../deadpool/src/engine/win-prob.js';
import { recommendDistinct } from '../deadpool/src/engine/strategies/distinct.js';

/* Two weeks of a hand-written games.csv, in nflverse's real column order. */
const HEADER = 'game_id,season,game_type,week,gameday,weekday,gametime,away_team,'
  + 'away_score,home_team,home_score,location,result,total,overtime,away_moneyline,'
  + 'home_moneyline,spread_line';
const CSV = [
  HEADER,
  '2026_01_NE_SEA,2026,REG,1,2026-09-10,Thursday,20:20,NE,,SEA,,Home,,,,150,-180,3.5',
  '2026_01_KC_DEN,2026,REG,1,2026-09-13,Sunday,16:25,KC,,DEN,,Home,,,,-300,240,-6.5',
  '2026_02_SF_ARI,2026,REG,2,2026-09-20,Sunday,13:00,SF,,ARI,,Home,,,,-150,130,2.5',
  '',
].join('\n');

const NFLVERSE = /raw\.githubusercontent\.com/;

/**
 * Run a handler with `fetch` stubbed. `espn` decides what ESPN does; the
 * fallback host always answers with the CSV above unless `csv` says otherwise.
 */
async function call(handler, url, { espn, csv = CSV } = {}) {
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  // The edge cache would serve the first answer to every later assertion.
  globalThis.caches = undefined;
  globalThis.fetch = async (target) => {
    if (NFLVERSE.test(String(target))) {
      return csv === null ? new Response('', { status: 404 }) : new Response(csv, { status: 200 });
    }
    return espn();
  };
  try {
    const res = await handler({ request: new Request(url) });
    return { status: res.status, headers: res.headers, body: JSON.parse(await res.text()) };
  } finally {
    globalThis.fetch = realFetch;
    globalThis.caches = realCaches;
  }
}

const refused = () => new Response('<html>Access Denied</html>', { status: 403 });
const espnBody = (events) => new Response(JSON.stringify({
  season: { year: 2026, type: 2 },
  week: { number: 1 },
  events,
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** ESPN answering 200 with nothing in it, which renders the same as a refusal. */
const scoreboard = () => espnBody([]);

/** ESPN answering properly, so the live path is the one that must be taken. */
const withGames = () => espnBody([{
  id: '401', date: '2026-09-13T17:00Z', status: { type: { state: 'pre' } },
  week: { number: 1 }, season: { year: 2026, type: 2 },
  competitions: [{
    id: '401',
    competitors: [
      { homeAway: 'home', score: '0', team: { id: '1', abbreviation: 'SEA', displayName: 'Seattle Seahawks', shortDisplayName: 'Seahawks' } },
      { homeAway: 'away', score: '0', team: { id: '2', abbreviation: 'NE', displayName: 'New England Patriots', shortDisplayName: 'Patriots' } },
    ],
  }],
}]);

/* --------------------------------------------------------------- /week -- */

test('a refusal from ESPN produces a board rather than a blank page', async () => {
  const { status, body } = await call(week, 'https://x.test/api/week?season=2026&week=1', { espn: refused });
  assert.equal(status, 200, 'the app is served something it can use, not a 502');
  assert.equal(body.ok, true);
  assert.equal(body.upstream, 'nflverse');
  assert.equal(body.games.length, 2);
  assert.equal(body.week, 1);
  assert.equal(body.season, 2026);
});

test('the fallback board carries the freshness it was written to have', async () => {
  // It did not. The TTL was passed as `{ maxAge: 900 }`, which json() does not
  // take, so this board was served on the 300-second default -- four times the
  // upstream traffic for a file that changes about once a day, and nothing to
  // show for it.
  const { headers, body } = await call(week, 'https://x.test/api/week?season=2026&week=1', { espn: refused });
  assert.match(headers.get('Cache-Control'), /max-age=900\b/);
  assert.equal(body.ttl, 900, 'and the body says the same number the header does');
});

test('and it says so, rather than letting the app present it as live', async () => {
  // The rule the whole design leans on: an app quietly showing the wrong
  // provenance is worse than one that admits what it has. This source carries
  // no live win probability and no kickoff state.
  const { body } = await call(week, 'https://x.test/api/week?season=2026&week=1', { espn: refused });
  // `source` is freshness and `upstream` is which one answered. They were one
  // field to begin with, and folding them turned a cached fallback board back
  // into a plain "cache" on reload -- at which point the app stopped saying
  // the odds were not live, which is the whole thing it has to say.
  assert.equal(body.source, 'live', 'it was just fetched, and that is what source means');
  assert.equal(body.upstream, 'nflverse', 'but not from ESPN, and that has to survive being cached');
  assert.match(body.note, /not live data/);
  assert.equal(body.upstreamReason, 'refused', 'and why the first source did not answer');
  assert.equal(body.upstreamStatus, 403);
});

test('the fallback board is priced, or it is not a board', async () => {
  // A slate with no numbers on it renders and recommends nothing. The prices
  // are the entire reason this file is the fallback and not, say, a bare
  // schedule scraped from a fixture list.
  const { body } = await call(week, 'https://x.test/api/week?season=2026&week=1', { espn: refused });
  const seattle = body.games.find((g) => g.home.abbreviation === 'SEA');
  assert.equal(seattle.odds.spread, -3.5, 'ESPN-signed, home-relative');
  assert.equal(seattle.odds.homeMoneyline, -180);
  assert.equal(seattle.probability, null, 'and no live model, honestly absent');
});

test('with no week asked for, it works out which one is on', async () => {
  // ESPN's scoreboard says which week it considers current. Without it the
  // app has to derive that, and a fallback that needed to be told the week
  // would be no use on the front page, which is where this matters.
  const { body } = await call(week, 'https://x.test/api/week', { espn: refused });
  assert.equal(body.ok, true);
  assert.ok(body.week >= 1 && body.week <= 18, `got week ${body.week}`);
});

test('ESPN answering still wins, and the fallback stays out of the way', async () => {
  const { body } = await call(week, 'https://x.test/api/week?season=2026&week=1', { espn: withGames });
  assert.equal(body.source, 'live');
  assert.equal(body.upstream, 'espn');
  assert.equal(body.note, undefined);
  assert.equal(body.games.length, 1);
});

test('an ESPN answer carrying no games is a failure, not an empty week', async () => {
  // 200 with an empty events array renders identically to a refusal --
  // "Nothing to show yet" on the front page -- so it has to take the same
  // path. A regular-season week with nothing in it is never true.
  const { status, body } = await call(week, 'https://x.test/api/week?season=2026&week=1', { espn: scoreboard });
  assert.equal(status, 200);
  assert.equal(body.upstream, 'nflverse');
  assert.equal(body.upstreamReason, 'empty', 'and it is distinguished from a refusal for whoever is debugging');
  assert.equal(body.games.length, 2);
});

test('when neither source has anything, it fails honestly', async () => {
  // Not an empty week: "no games" is a sentence somebody believes.
  const { status, body } = await call(week, 'https://x.test/api/week?season=2026&week=1',
    { espn: refused, csv: null });
  assert.equal(status, 502);
  assert.equal(body.ok, false);
  assert.equal(body.upstreamReason, 'refused');
  // The sentence names both sources: "ESPN did not answer" was true of one
  // rung and read, on the front page, as the whole story.
  assert.match(body.error, /either source/);
});

test('a season the fallback has never heard of is a failure, not an empty board', async () => {
  const { status, body } = await call(week, 'https://x.test/api/week?season=2099&week=1', { espn: refused });
  assert.equal(status, 502);
  assert.equal(body.ok, false);
});

/* ------------------------------------------------------------- /season -- */

test('the season falls back too, which is what keeps the lookahead alive', async () => {
  // future_value scores this week's matchup against the next several, and
  // with no schedule it comes out null and the strategy that reads it
  // silently degenerates to plain win-probability ranking. Losing the
  // lookahead quietly is exactly the failure this endpoint exists to fix.
  const { status, body } = await call(season, 'https://x.test/api/season?season=2026', { espn: refused });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.upstream, 'nflverse');
  assert.deepEqual(Object.keys(body.weeks).map(Number).sort((a, b) => a - b), [1, 2]);
  assert.equal(body.weeks[1].length, 2);
});

test('it reports the weeks it does not have, and how far the market has priced', async () => {
  const { body } = await call(season, 'https://x.test/api/season?season=2026', { espn: refused });
  assert.deepEqual(body.missingWeeks, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.equal(body.pricedThrough, 2, 'the lookahead sees this far and no further');
});

test('a season with nothing in the file is refused rather than served empty', async () => {
  const { status, body } = await call(season, 'https://x.test/api/season?season=2099', { espn: refused });
  assert.equal(status, 502);
  assert.equal(body.ok, false);
});

/* ----------------------------------------------------- against the real file -- */

test('the real file, through the real endpoints, produces a real pair of picks', async () => {
  // Everything above runs on a hand-written CSV so the suite needs no network.
  // That proves the wiring and not the product: the claim being made is that
  // somebody can open this app with ESPN refusing and get a pick, and the only
  // honest way to check it is to drive both endpoints over the actual 2 MB
  // file with the actual 403 and see a team come out.
  //
  // Skipped rather than failed when the backtester's cache is absent, because
  // this file is downloaded by an authoring tool and the suite may never fetch.
  const cached = 'cache/nflverse-games.csv';
  if (!existsSync(cached)) return;
  const real = readFileSync(cached, 'utf8');

  const w = await call(week, 'https://x.test/api/week', { espn: refused, csv: real });
  assert.equal(w.body.ok, true);
  assert.equal(w.body.upstream, 'nflverse');
  assert.equal(w.body.upstreamStatus, 403, 'and it is the refusal that actually happens');
  assert.equal(w.body.games.length, 16, 'a modern NFL week is sixteen games');
  assert.ok(w.body.games.every((g) => g.startDate), 'every game needs a kickoff, or nothing can lock');
  assert.ok(w.body.games.some((g) => g.odds?.homeMoneyline), 'and the board has to be priced');

  const s = await call(season, `https://x.test/api/season?season=${w.body.season}`, { espn: refused, csv: real });
  assert.equal(s.body.ok, true);
  assert.equal(Object.keys(s.body.weeks).length, 18, 'the lookahead wants the whole regular season');
  assert.ok(s.body.pricedThrough >= 1, 'and at least one week of it priced');

  // The whole claim, as one assertion: a pick for each entry, on different
  // teams, from a source that is not ESPN.
  const table = buildWinProbabilityTable(Object.values(s.body.weeks).flat());
  const d = recommendDistinct(
    w.body.games, table, w.body.week,
    { 'Entry A': [], 'Entry B': [] }, ['Entry A', 'Entry B'],
  );
  const a = d.picks['Entry A']?.teamAbbreviation;
  const b = d.picks['Entry B']?.teamAbbreviation;
  assert.ok(a && b, `both entries must get a pick, got ${a} and ${b}`);
  assert.notEqual(a, b, 'and not the same one');
});
