/**
 * The second source, and the reason the app is allowed to have one.
 *
 * ESPN went from working to refusing the edge Function outright — Akamai
 * answering 403 to this User-Agent while the same URL returns 200 to curl —
 * and the whole product went blank rather than degraded, because a survivor
 * pick needs a slate and there was no other way to get one. nflverse's
 * games.csv is that other way, and these tests are what make it trustworthy
 * enough to serve.
 *
 * The load-bearing one is the last: a week parsed out of this file has to go
 * all the way through the real win-probability table into a real pick. Every
 * field could be individually plausible and the board still come out empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import {
  parseNflverseWeek,
  nflverseWeeks,
  currentWeekFrom,
  currentSeason,
} from '../deadpool/src/engine/nflverse.js';
import { buildWinProbabilityTable } from '../deadpool/src/engine/win-prob.js';
import * as sequence from '../deadpool/src/engine/strategies/sequence-dp.js';

/* A hand-written file in the real column order, so the tests do not depend on
   a 2 MB download. The one below reads the real file when it happens to be
   cached, which is the check that the shape written here is the shape shipped. */
const HEADER = 'game_id,season,game_type,week,gameday,weekday,gametime,away_team,'
  + 'away_score,home_team,home_score,location,result,total,overtime,away_moneyline,'
  + 'home_moneyline,spread_line';

const row = (o) => [
  o.id, o.season, o.type ?? 'REG', o.week, o.day, o.weekday ?? 'Sunday', o.time ?? '13:00',
  o.away, o.awayScore ?? '', o.home, o.homeScore ?? '', 'Home', o.result ?? '', '', '',
  o.awayMl ?? '', o.homeMl ?? '', o.spread ?? '',
].join(',');

const CSV = [
  HEADER,
  // Week 1: home favoured by 3.5, and a Thursday night kickoff in Eastern.
  row({ id: '2026_01_NE_SEA', season: 2026, week: 1, day: '2026-09-10', time: '20:20', away: 'NE', home: 'SEA', spread: '3.5', homeMl: '-180', awayMl: '150' }),
  // Same week, away favoured: the sign has to come out the other way round.
  row({ id: '2026_01_KC_DEN', season: 2026, week: 1, day: '2026-09-13', away: 'KC', home: 'DEN', spread: '-6.5', homeMl: '240', awayMl: '-300' }),
  // A game that has already been played.
  row({ id: '2026_01_BUF_NYJ', season: 2026, week: 1, day: '2026-09-13', away: 'BUF', home: 'NYJ', spread: '7', homeMl: '-320', awayMl: '260', result: '10' }),
  // Monday night, which is what actually ends a week.
  row({ id: '2026_01_MIN_CHI', season: 2026, week: 1, day: '2026-09-14', weekday: 'Monday', time: '20:15', away: 'MIN', home: 'CHI', spread: '1.5', homeMl: '-120', awayMl: '100' }),
  // Week 2, and a row with no price at all.
  row({ id: '2026_02_SF_ARI', season: 2026, week: 2, day: '2026-09-20', away: 'SF', home: 'ARI', spread: '4' }),
  row({ id: '2026_02_GB_CHI', season: 2026, week: 2, day: '2026-09-20', away: 'GB', home: 'CHI' }),
  // December, on the other side of the daylight-saving changeover.
  row({ id: '2026_15_ATL_TB', season: 2026, week: 15, day: '2026-12-13', time: '16:25', away: 'ATL', home: 'TB', spread: '2.5', homeMl: '-140', awayMl: '120' }),
  // Noise the reader has to skip: another season, and a playoff game.
  row({ id: '2025_01_DAL_PHI', season: 2025, week: 1, day: '2025-09-04', away: 'DAL', home: 'PHI', spread: '8.5', homeMl: '-400', awayMl: '320' }),
  row({ id: '2026_19_LA_SEA', season: 2026, type: 'WC', week: 19, day: '2027-01-10', away: 'LA', home: 'SEA', spread: '3' }),
  '',
].join('\n');

const byTeam = (games, abbr) => games.find((g) => g.home.abbreviation === abbr || g.away.abbreviation === abbr);

/* ------------------------------------------------------- the sign trap -- */

test('the spread is negated, because nflverse and ESPN disagree about which way is favoured', () => {
  // The bug this prevents does not throw. nflverse writes +3.5 when the HOME
  // team is favoured; ESPN writes -3.5, and models/win_prob.py reads ESPN's.
  // Carried across unchanged, every game recommends the underdog and it looks
  // like a strategy having a bad season rather than a parser being backwards.
  const games = parseNflverseWeek(CSV, 2026, 1);
  const seattle = byTeam(games, 'SEA');
  assert.equal(seattle.odds.spread, -3.5, 'home favourite must come out negative, ESPN-style');
  assert.equal(seattle.odds.favoriteAbbreviation, 'SEA');

  // Both conventions are signed relative to the home team, so an away
  // favourite is a POSITIVE number in ESPN's -- home is the underdog by 6.5.
  // estimate_win_pct_from_spread does `home_favored_by = -spread`, which is
  // the line that decides this and the reason it is asserted here.
  const denver = byTeam(games, 'DEN');
  assert.equal(denver.odds.spread, 6.5, 'an away favourite leaves home on the positive side');
  assert.equal(denver.odds.favoriteAbbreviation, 'KC', 'and the favourite is the away team');
  assert.equal(denver.odds.details, 'KC -6.5', 'said the way a person reads a line');
});

test('the moneylines are carried across as they are', () => {
  // American odds are American odds. This is the field win-prob.js actually
  // prefers, so getting it wrong is worse than getting the spread wrong.
  const seattle = byTeam(parseNflverseWeek(CSV, 2026, 1), 'SEA');
  assert.equal(seattle.odds.homeMoneyline, -180);
  assert.equal(seattle.odds.awayMoneyline, 150);
});

/* --------------------------------------------------------- the clock -- */

test('a kickoff time is Eastern, and is converted rather than stamped Z', () => {
  // `gametime` reads 20:20 for a Thursday night game. Stamping that with a Z
  // puts the lock four hours early: nextLock() counts down to the wrong
  // moment and ttlFor() calls the week finished while it is being played.
  const seattle = byTeam(parseNflverseWeek(CSV, 2026, 1), 'SEA');
  assert.equal(seattle.startDate, '2026-09-11T00:20:00.000Z', '20:20 ET on the 10th is 00:20 UTC on the 11th');
});

test('and the offset follows the season across the daylight-saving change', () => {
  // September is UTC-4 and December is UTC-5. A hard-coded offset is right
  // for one half of a season and an hour out for the other.
  const tampa = byTeam(parseNflverseWeek(CSV, 2026, 15), 'TB');
  assert.equal(tampa.startDate, '2026-12-13T21:25:00.000Z', '16:25 ET in December is 21:25 UTC');
});

test('a row with no time keeps its date rather than losing it', () => {
  // Older rows carry no gametime. Midnight UTC is early; null would drop the
  // game out of the lock countdown altogether, which is worse.
  const csv = [HEADER, row({ id: '2001_01_A_B', season: 2001, week: 1, day: '2001-09-09', time: '', away: 'SF', home: 'ARI' }), ''].join('\n');
  assert.equal(parseNflverseWeek(csv, 2001, 1)[0].startDate, '2001-09-09T00:00:00Z');
});

/* ---------------------------------------------------------- selection -- */

test('it returns one week of one season, and skips the playoffs', () => {
  const week1 = parseNflverseWeek(CSV, 2026, 1);
  assert.equal(week1.length, 4);
  assert.ok(week1.every((g) => g.week === 1 && g.seasonYear === 2026));

  assert.equal(parseNflverseWeek(CSV, 2025, 1).length, 1, 'a different season is a different board');
  assert.equal(parseNflverseWeek(CSV, 2026, 19).length, 0, 'the wild-card round is not a survivor week');
});

test('a played game is marked post, so it cannot still be picked', () => {
  // The file is refreshed daily, so it holds results. A finished game left as
  // `pre` stays selectable on the board.
  const games = parseNflverseWeek(CSV, 2026, 1);
  assert.equal(byTeam(games, 'NYJ').state, 'post');
  assert.equal(byTeam(games, 'SEA').state, 'pre');
});

test('a game with no price gets null odds rather than a fabricated line', () => {
  const games = parseNflverseWeek(CSV, 2026, 2);
  assert.equal(byTeam(games, 'CHI').odds, null, 'no spread and no moneyline is no price');
  assert.equal(byTeam(games, 'ARI').odds.spread, -4, 'a spread with no moneyline is still a price');
  assert.equal(byTeam(games, 'ARI').odds.homeMoneyline, null);
});

test('there is never a live win probability, because the file has none', () => {
  // Null rather than a guess. win-prob.js falls to the moneyline, which is
  // here; a fabricated probability would outrank the real price.
  assert.ok(parseNflverseWeek(CSV, 2026, 1).every((g) => g.probability === null));
});

test('the weeks it covers are reported, regular season only', () => {
  assert.deepEqual(nflverseWeeks(CSV, 2026), [1, 2, 15]);
  assert.deepEqual(nflverseWeeks(CSV, 2030), [], 'a season it does not hold is empty, not an error');
});

/* ------------------------------------------------------ malformed input -- */

test('rubbish in gives an empty board rather than a stack trace', () => {
  // This runs at the edge on a file fetched from somebody else's repository.
  // A throw here is a 500 on the front page.
  for (const bad of ['', null, undefined, 'not a csv', 'a,b,c\n1,2,3', HEADER]) {
    assert.deepEqual(parseNflverseWeek(bad, 2026, 1), [], JSON.stringify(bad));
    assert.deepEqual(nflverseWeeks(bad, 2026), []);
    assert.equal(currentWeekFrom(bad, 2026, Date.parse('2026-09-10T12:00:00Z')), null);
  }
});

test('a file that lost its season column is refused, not guessed at', () => {
  // The prefix filter reads game_id's first four characters, which is a real
  // property of this file. The season column is checked again per row so a
  // file that stopped holding to it returns nothing rather than a wrong year.
  const noSeason = ['game_id,game_type,week,gameday,home_team,away_team',
    '2026_01_NE_SEA,REG,1,2026-09-10,SEA,NE', ''].join('\n');
  assert.deepEqual(parseNflverseWeek(noSeason, 2026, 1), []);
});

/* --------------------------------------------------------- which week -- */

test('the current week is the earliest one not yet finished', () => {
  const at = (d) => currentWeekFrom(CSV, 2026, Date.parse(d));
  assert.equal(at('2026-08-23T12:00:00Z'), 1, 'before the season starts, week 1 is next');
  assert.equal(at('2026-09-10T12:00:00Z'), 1, 'on the day of the opener');
  assert.equal(at('2026-09-16T12:00:00Z'), 2);
  assert.equal(at('2026-12-13T12:00:00Z'), 15,
    'it skips the weeks already played rather than stopping at the first gap');
  assert.equal(at('2027-03-01T12:00:00Z'), null, 'the season is behind us and nothing is current');
});

test("Sunday's games stay current through Monday night", () => {
  // Reading `gameday` as a bare UTC midnight -- the obvious shortcut -- ends
  // week 1 at 8pm Eastern on its own last day, so an app open during Sunday
  // Night Football has already moved on to next week's board.
  const at = (d) => currentWeekFrom(CSV, 2026, Date.parse(d));
  assert.equal(at('2026-09-14T01:00:00Z'), 1, 'Sunday night, 9pm Eastern: still week 1');
  assert.equal(at('2026-09-15T01:00:00Z'), 1, 'Monday night kickoff: still week 1');
  assert.equal(at('2026-09-15T12:00:00Z'), 2, 'Tuesday morning: week 2');
});

test('neither clock-reading helper has a clock of its own', () => {
  // src/engine/ may not read one -- test/engine.test.js enforces it, because
  // the Python and the browser have to be replayable against each other. A
  // default `now` would be the exception that makes the next one look fine,
  // so the absence throws rather than quietly picking today.
  assert.throws(() => currentSeason(), TypeError);
  assert.throws(() => currentWeekFrom(CSV, 2026), TypeError);
});

test('a season year is not a calendar year in January', () => {
  // The 2026 season's last regular week falls in January 2027. Asking the
  // file for "2027" then returns an empty board, in the middle of the weeks
  // that decide a pool.
  const on = (d) => currentSeason(Date.parse(d));
  assert.equal(on('2026-09-10T12:00:00Z'), 2026);
  assert.equal(on('2027-01-04T12:00:00Z'), 2026, 'January belongs to the season before it');
  assert.equal(on('2027-02-20T12:00:00Z'), 2026);
  assert.equal(on('2027-03-15T12:00:00Z'), 2027, 'the league year turns over in March');
});

/* ------------------------------------------------------- end to end -- */

test('a week of this file goes all the way through to a real pick', () => {
  // The whole claim, tested as one thing. Every field above could be
  // individually plausible and the board still come out empty -- which is
  // exactly what the app did when ESPN stopped answering.
  const games = [...parseNflverseWeek(CSV, 2026, 1), ...parseNflverseWeek(CSV, 2026, 2)];
  const table = buildWinProbabilityTable(games);
  const week1 = parseNflverseWeek(CSV, 2026, 1);

  const rec = sequence.recommend(week1, table, 1, []);
  assert.ok(rec.pick, 'a slate from this source must produce a pick');
  assert.ok(rec.pick.winPct > 0.5, `the favourite should be favoured, got ${rec.pick.winPct}`);
  assert.equal(rec.pick.teamAbbreviation, 'KC',
    'KC at -300 is the strongest price on the board, and the sign convention is what decides that');
  assert.ok(rec.reasoning, 'and it must be able to say why');
});

test('the shape written in this file is the shape nflverse actually ships', () => {
  // The tests above run on a hand-written CSV so they need no network. That
  // is only worth anything while the hand-written columns match the real
  // ones, so when the backtester's cache happens to be present, check.
  const cached = 'cache/nflverse-games.csv';
  if (!existsSync(cached)) return;   // not an error: the cache is optional
  const real = readFileSync(cached, 'utf8');

  const [headerLine, firstRow] = real.split('\n');
  const theirs = new Set(headerLine.split(','));
  for (const c of HEADER.split(',')) assert.ok(theirs.has(c), `nflverse no longer publishes '${c}'`);
  assert.deepEqual(headerLine.split(',').slice(0, 4), ['game_id', 'season', 'game_type', 'week'],
    'the first four columns are what the row filter and the season check read');

  // The filter reads game_id's first four characters as the season. That is a
  // property of this file rather than of CSV, so it is checked against the
  // file rather than assumed -- on every row, since one exception is enough.
  const rows = real.split('\n').filter(Boolean).slice(1);
  const wrong = rows.filter((r) => r.slice(0, 4) !== r.split(',')[1]);
  assert.equal(wrong.length, 0, `game_id stopped starting with the season on ${wrong.length} rows`);
  assert.ok(rows.length > 6000, 'and the file still holds every season since 1999');
  assert.ok(firstRow.startsWith('1999_'), 'starting with 1999');

  // The newest season the file holds, not "this" season: the cache on disk is
  // whenever somebody last ran the backtester, and asking a clock here would
  // make the assertion fail for being out of date rather than for being wrong.
  const season = Math.max(...rows.map((r) => Number(r.split(',')[1])).filter(Number.isFinite));
  const weeks = nflverseWeeks(real, season);
  assert.ok(weeks.length >= 18, `the newest season in the file (${season}) should be complete, got ${weeks.length} weeks`);
  const games = parseNflverseWeek(real, season, 1);
  assert.equal(games.length, 16, 'a modern week 1 is sixteen games');
  assert.ok(games.some((g) => g.odds && g.odds.homeMoneyline !== null), 'and at least one of them is priced');
});
