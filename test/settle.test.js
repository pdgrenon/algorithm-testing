/**
 * Results that settle themselves.
 *
 * The app has always held the answer — /api/week carries `winner` and `state`,
 * and pick_history.py has resolved picks against exactly those since before
 * the app existed — and made somebody tap it in anyway.
 *
 * Two properties are worth more than the rest and most of this file is about
 * them:
 *
 *   **A tie is not a loss.** ESPN sends `winner: false` on *both* sides of a
 *   tie, so a resolver that reads that field before comparing scores calls a
 *   tie a loss. In this pool a tie advances you, so that is the difference
 *   between being in the pool and being told you are out.
 *
 *   **A person always wins.** A result somebody typed is never overwritten by
 *   an automatic pass, because a pool can rule a game in a way the feed does
 *   not and the person is the one who knows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveResult, settleable } from '../deadpool/src/store/derive.js';
import { parseNflverseWeek } from '../deadpool/src/engine/nflverse.js';

const side = (abbr, score, winner) => ({ abbreviation: abbr, score, winner, displayName: abbr });

const game = ({ id = '1', state = 'post', home = 'KC', away = 'DEN', hs = 27, as = 17 } = {}) => ({
  eventId: id,
  week: 1,
  state,
  startDate: '2026-09-13T17:00:00Z',
  home: side(home, hs, hs === as ? false : hs > as),
  away: side(away, as, hs === as ? false : as > hs),
});

const pick = (over = {}) => ({
  id: '2026-01-A', entry: 'A', season: 2026, week: 1, team: 'KC',
  opponent: 'DEN', eventId: '1', result: 'pending', ...over,
});

/* -------------------------------------------------------------- resolving -- */

test('a won game settles to a win', () => {
  assert.equal(resolveResult(pick(), [game()]), 'win');
});

test('a lost game settles to a loss', () => {
  assert.equal(resolveResult(pick({ team: 'DEN', opponent: 'KC' }), [game()]), 'loss');
});

test('a tie settles to a tie, not a loss', () => {
  // The one that inverts an answer. Both sides carry winner:false on a tie.
  const drawn = game({ hs: 20, as: 20 });
  assert.equal(drawn.home.winner, false, 'ESPN convention: false on both sides');
  assert.equal(drawn.away.winner, false);
  assert.equal(resolveResult(pick(), [drawn]), 'tie');
  assert.equal(resolveResult(pick({ team: 'DEN' }), [drawn]), 'tie');
});

test('a game that has not kicked off settles to nothing', () => {
  assert.equal(resolveResult(pick(), [game({ state: 'pre' })]), null);
});

test('a game in progress settles to nothing, however lopsided the score', () => {
  // ESPN publishes a running score from the first snap, so a team 27-0 up at
  // half time reads exactly like a team that won. Only 'post' is final.
  assert.equal(resolveResult(pick(), [game({ state: 'in', hs: 27, as: 0 })]), null);
});

test('a game absent from the payload settles to nothing', () => {
  assert.equal(resolveResult(pick({ team: 'SF', eventId: null }), [game()]), null);
  assert.equal(resolveResult(pick(), []), null);
});

test('a finished game whose source will not name a winner settles to nothing', () => {
  const mute = { ...game(), home: side('KC', null, null), away: side('DEN', null, null) };
  assert.equal(resolveResult(pick(), [mute]), null);
});

test('a 0-0 final is a tie, not an absent score', () => {
  assert.equal(resolveResult(pick(), [game({ hs: 0, as: 0 })]), 'tie');
});

test('the eventId is preferred, so a stale row for the same team cannot match', () => {
  const stale = game({ id: 'old', hs: 3, as: 40 });      // KC lost this one
  const real = game({ id: '1', hs: 27, as: 17 });        // and won this one
  assert.equal(resolveResult(pick({ eventId: '1' }), [stale, real]), 'win');
});

test('a pick with no eventId still matches by team, for imported picks', () => {
  // The terminal tool stores neither an event id nor an opponent.
  assert.equal(resolveResult(pick({ eventId: null }), [game()]), 'win');
});

test('an eventId compares as a string, since one source numbers and the other does not', () => {
  assert.equal(resolveResult(pick({ eventId: 1 }), [game({ id: '1' })]), 'win');
});

test('a malformed pick or payload resolves to nothing rather than throwing', () => {
  assert.equal(resolveResult(null, [game()]), null);
  assert.equal(resolveResult(pick({ team: null }), [game()]), null);
  assert.equal(resolveResult(pick(), null), null);
  assert.equal(resolveResult(pick(), [{ eventId: '1', state: 'post' }]), null);
});

/* ---------------------------------------------------------------- batching -- */

test('settleable returns only what changed, as id and result', () => {
  const picks = [pick(), pick({ id: '2026-01-B', entry: 'B', team: 'DEN' })];
  assert.deepEqual(settleable(picks, [game()]), [
    { id: '2026-01-A', result: 'win' },
    { id: '2026-01-B', result: 'loss' },
  ]);
});

test('a result already recorded is never reconsidered', () => {
  // The safety property. Somebody correcting the app knows something it does
  // not -- a pool ruling a game differently, a forfeit -- and an automatic
  // pass that reverted them would make the app unusable for the person paying
  // most attention.
  for (const already of ['win', 'loss', 'tie']) {
    assert.deepEqual(settleable([pick({ result: already })], [game()]), [],
      `a ${already} must not be revisited`);
  }
});

test('a person calling a loss a win survives a refresh', () => {
  const corrected = pick({ result: 'win', resultSource: 'manual' });
  // The game says KC lost; the person says otherwise and stays right.
  assert.deepEqual(settleable([corrected], [game({ hs: 3, as: 40 })]), []);
});

test('settleable is empty when nothing is decidable', () => {
  assert.deepEqual(settleable([pick()], [game({ state: 'pre' })]), []);
  assert.deepEqual(settleable([], [game()]), []);
});

/* ------------------------------------------------- the fallback source -- */

const HEADER = 'game_id,season,game_type,week,gameday,weekday,gametime,away_team,'
  + 'away_score,home_team,home_score,location,result,total,overtime,away_moneyline,'
  + 'home_moneyline,spread_line';

const row = (o) => [
  o.id, o.season, 'REG', o.week, o.day, 'Sunday', o.time ?? '13:00',
  o.away, o.awayScore ?? '', o.home, o.homeScore ?? '', 'Home', o.result ?? '', '', '',
  o.awayMl ?? '', o.homeMl ?? '', o.spread ?? '',
].join(',');

const csv = (...rows) => [HEADER, ...rows].join('\n');

test('a played nflverse row carries its score and its winner', () => {
  // These columns were read only to decide `state` and thrown away, so every
  // finished game on this source looked like one nobody knew the result of.
  // It is the source that matters for settling: ESPN is the one answering 403.
  const games = parseNflverseWeek(csv(row({
    id: '2026_01_DEN_KC', season: 2026, week: 1, day: '2026-09-13',
    away: 'DEN', home: 'KC', awayScore: '17', homeScore: '27', result: '10',
  })), 2026, 1);

  assert.equal(games.length, 1);
  assert.equal(games[0].state, 'post');
  assert.equal(games[0].home.score, 27);
  assert.equal(games[0].away.score, 17);
  assert.equal(games[0].home.winner, true);
  assert.equal(games[0].away.winner, false);
});

test('an unplayed nflverse row stays null on both sides, not zero', () => {
  // 0-0 is a real final somebody could be eliminated by, so an absent score
  // must not become one.
  const games = parseNflverseWeek(csv(row({
    id: '2026_02_DEN_KC', season: 2026, week: 2, day: '2026-09-20', away: 'DEN', home: 'KC',
  })), 2026, 2);

  assert.equal(games[0].state, 'pre');
  assert.equal(games[0].home.score, null);
  assert.equal(games[0].home.winner, null);
  assert.equal(games[0].away.winner, null);
});

test('an nflverse tie is false on both sides, matching ESPN', () => {
  const games = parseNflverseWeek(csv(row({
    id: '2026_01_DEN_KC', season: 2026, week: 1, day: '2026-09-13',
    away: 'DEN', home: 'KC', awayScore: '20', homeScore: '20', result: '0',
  })), 2026, 1);

  assert.equal(games[0].home.winner, false);
  assert.equal(games[0].away.winner, false);
  // And the resolver reads it as a tie, from the scores rather than the flag.
  assert.equal(resolveResult(pick({ eventId: '2026_01_DEN_KC' }), games), 'tie');
});

test('one resolver settles a pick off either source, identically', () => {
  const fromNflverse = parseNflverseWeek(csv(row({
    id: '2026_01_DEN_KC', season: 2026, week: 1, day: '2026-09-13',
    away: 'DEN', home: 'KC', awayScore: '17', homeScore: '27', result: '10',
  })), 2026, 1);

  assert.equal(resolveResult(pick({ eventId: '2026_01_DEN_KC' }), fromNflverse), 'win');
  assert.equal(resolveResult(pick({ eventId: '1' }), [game()]), 'win');
});

/* ------------------------------------------------------ through the store -- */

test('settleResults writes the batch and stamps it auto', async () => {
  const { installLocalStorage, freshStore } = await import('./helpers/local-storage.js');
  installLocalStorage();
  const store = await freshStore();

  store.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC', opponent: 'DEN', eventId: '1' });
  store.recordPick({ entry: 'B', season: 2026, week: 1, team: 'DEN', opponent: 'KC', eventId: '1' });

  const { ok, changed } = store.settleResults([game()]);
  assert.equal(ok, true);
  assert.equal(changed.length, 2);

  const after = store.getPicks();
  assert.equal(after.find((p) => p.entry === 'A').result, 'win');
  assert.equal(after.find((p) => p.entry === 'B').result, 'loss');
  for (const p of after) {
    assert.equal(p.resultSource, 'auto');
    assert.ok(p.resultAt, 'and stamped with when');
  }
});

test('settling twice is a no-op the second time', async () => {
  const { installLocalStorage, freshStore } = await import('./helpers/local-storage.js');
  installLocalStorage();
  const store = await freshStore();
  store.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC', eventId: '1' });

  assert.equal(store.settleResults([game()]).changed.length, 1);
  assert.equal(store.settleResults([game()]).changed.length, 0, 'nothing left to settle');
});

test('a manual result set through the store is not re-settled', async () => {
  const { installLocalStorage, freshStore } = await import('./helpers/local-storage.js');
  installLocalStorage();
  const store = await freshStore();
  const { pick: recorded } = store.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC', eventId: '1' });

  store.setResult(recorded.id, 'tie');
  assert.equal(store.getPicks()[0].resultSource, 'manual');

  assert.equal(store.settleResults([game()]).changed.length, 0);
  assert.equal(store.getPicks()[0].result, 'tie', 'the person still wins');
});

test('a refused write settles nothing rather than half of it', async () => {
  const { installLocalStorage, freshStore } = await import('./helpers/local-storage.js');
  const ls = installLocalStorage();
  const store = await freshStore();
  store.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC', eventId: '1' });

  // A device that has just run out of room. The in-memory log must go back to
  // what is actually on disk, or the app shows a settled season that is gone
  // at the next reload.
  ls.setItem = () => { const e = new Error('exceeded the quota'); e.name = 'QuotaExceededError'; throw e; };

  const { ok, changed } = store.settleResults([game()]);
  assert.equal(ok, false);
  assert.deepEqual(changed, []);
  assert.equal(store.getPicks()[0].result, 'pending', 'rolled back to what is on disk');
});
