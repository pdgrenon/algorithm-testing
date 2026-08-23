/**
 * The store, and the derivations that make the pick log the only truth.
 *
 * Two groups of assertions. The first is about deriving: that used teams,
 * elimination and the record all fall out of the log, so correcting one pick
 * corrects the whole app. The second is about the failure paths — a write that
 * is refused, bytes that will not parse, a record from a newer version — which
 * are the ones that quietly lose a season if they are wrong.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage, freshStore } from './helpers/local-storage.js';
import { statusOf, usedTeams, boardFor, pickId } from '../deadpool/src/store/derive.js';
import { migrate, SCHEMA } from '../deadpool/src/store/migrations.js';

let ls;
beforeEach(() => { ls = installLocalStorage(); });

const pick = (over = {}) => ({
  id: pickId(over.season ?? 2026, over.week ?? 1, over.entry ?? 'A'),
  entry: 'A', season: 2026, week: 1, team: 'KC', result: 'pending', ...over,
});

/* --------------------------------------------------------- derivations -- */

test('a team is spent the moment it is picked, not when the game ends', () => {
  const picks = [pick({ team: 'KC', result: 'pending' })];
  assert.deepEqual(usedTeams(picks, 'A', 2026), ['KC'],
    'a pending pick still burns the team — otherwise it is offered twice on a Sunday morning');
});

test('one loss eliminates in a one-strike pool, and the week is recorded', () => {
  const picks = [
    pick({ week: 1, team: 'KC', result: 'win' }),
    pick({ week: 2, team: 'BUF', result: 'loss' }),
    pick({ week: 3, team: 'SF', result: 'pending' }),
  ];
  const s = statusOf(picks, 'A', 2026, { strikesAllowed: 1 });
  assert.equal(s.alive, false);
  assert.equal(s.eliminatedWeek, 2);
  assert.equal(s.record, '1-1');
});

test('a two-strike pool survives the first loss', () => {
  const picks = [pick({ week: 1, result: 'loss' }), pick({ week: 2, team: 'BUF', result: 'win' })];
  assert.equal(statusOf(picks, 'A', 2026, { strikesAllowed: 2 }).alive, true);
  assert.equal(statusOf(picks, 'A', 2026, { strikesAllowed: 1 }).alive, false);
});

test('a tie survives by default, and only eliminates when the pool says so', () => {
  const picks = [pick({ result: 'tie' })];
  // The default is the assertion that matters. Both calls below passed it
  // explicitly, so nothing held the default itself -- and the docstring over
  // statusOf claimed it was the other way round.
  assert.equal(statusOf(picks, 'A', 2026).alive, true,
    'confirmed for this pool: a tie is a win for both sides');
  assert.equal(statusOf(picks, 'A', 2026, {}).alive, true, 'and an empty options object is the same');
  assert.equal(statusOf(picks, 'A', 2026, { tieIsLoss: true }).alive, false);
  assert.equal(statusOf(picks, 'A', 2026, { tieIsLoss: false }).alive, true);
});

test('each entry is derived from its own picks alone', () => {
  const picks = [pick({ entry: 'A', team: 'KC', result: 'loss' }), pick({ entry: 'B', team: 'SF', result: 'win' })];
  assert.equal(statusOf(picks, 'A', 2026).alive, false);
  assert.equal(statusOf(picks, 'B', 2026).alive, true);
  assert.deepEqual(usedTeams(picks, 'B', 2026), ['SF']);
});

test('the board separates used, available, started and bye', () => {
  const games = [
    { eventId: '1', state: 'pre', startDate: null, home: { abbreviation: 'KC' }, away: { abbreviation: 'DEN' } },
    { eventId: '2', state: 'in', startDate: null, home: { abbreviation: 'SF' }, away: { abbreviation: 'SEA' } },
  ];
  const board = boardFor([pick({ team: 'KC' })], 'A', 2026, games, ['KC', 'DEN', 'SF', 'SEA', 'BUF']);
  const state = Object.fromEntries(board.map((b) => [b.abbr, b.state]));
  assert.deepEqual(state, { KC: 'used', DEN: 'available', SF: 'started', SEA: 'started', BUF: 'bye' },
    'four states, because those are the four questions somebody has in front of a board');
});

/* -------------------------------------------------------------- writes -- */

test('a slot holds one pick — picking again replaces rather than accumulates', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'BUF' });
  assert.equal(s.getPicks().length, 1);
  assert.equal(s.getPicks()[0].team, 'BUF');
});

test('changing the team clears a recorded result; re-picking the same team keeps it', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  s.setResult('2026-01-A', 'win');

  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  assert.equal(s.getPicks()[0].result, 'win', 'the same team is the same pick — the outcome still stands');

  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'BUF' });
  assert.equal(s.getPicks()[0].result, 'pending', 'a different team is a different bet, so the old result cannot carry over');
});

test('a removed pick can be put back exactly as it was', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC', snapshot: { winPct: 78.4 } });
  s.setResult('2026-01-A', 'win');
  const { previous } = s.removePick('2026-01-A');
  assert.equal(s.getPicks().length, 0);
  s.restorePick(previous);
  assert.deepEqual(s.getPicks()[0], previous, 'undo has to restore the snapshot too, or the season review loses it');
});

test('deleting a pick corrects everything derived from it', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  s.setResult('2026-01-A', 'loss');
  assert.equal(s.statusFor('A').alive, false);
  s.removePick('2026-01-A');
  assert.equal(s.statusFor('A').alive, true, 'nothing is stored twice, so one correction is the whole correction');
  assert.deepEqual(s.usedTeamsFor('A'), []);
});

/* ------------------------------------------------------------ failures -- */

test('a refused write is reported rather than silently dropped', async () => {
  installLocalStorage({ blocked: true });
  const s = await freshStore(); s.load();
  const { ok } = s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  assert.equal(ok, false, 'the caller must be able to tell the pick did not save');
  const alarm = s.storage.currentAlarm();
  assert.ok(alarm && alarm.kind === 'blocked');
  assert.match(alarm.detail, /refused to save/);
});

test('a full device names the quota and points at the fix', async () => {
  installLocalStorage({ quota: 120 });
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  const alarm = s.storage.currentAlarm();
  assert.ok(alarm && alarm.kind === 'full', 'quota exhaustion is a different problem from a blocked store and reads differently');
  assert.match(alarm.detail, /export a backup first/);
});

test('bytes that will not parse are kept, not overwritten', async () => {
  ls._poison('deadpool.picks.v1', '{"picks": [oh no');
  const s = await freshStore(); s.load();
  assert.deepEqual(s.getPicks(), [], 'the app still runs');
  assert.equal(ls.getItem('deadpool.picks.v1.corrupt'), '{"picks": [oh no',
    'there is no server, so those bytes are the only bytes there are');
  assert.equal(s.storage.currentAlarm().kind, 'unreadable');
});

test('a second failure does not destroy the evidence from the first', async () => {
  ls._poison('deadpool.picks.v1', 'FIRST');
  let s = await freshStore(); s.load();
  ls._poison('deadpool.picks.v1', 'SECOND');
  s = await freshStore(); s.load();
  assert.equal(ls.getItem('deadpool.picks.v1.corrupt'), 'FIRST',
    'the first quarantine is usually the more complete record');
});

/* ---------------------------------------------------------- migrations -- */

test('a record from a newer version is refused, and left untouched', () => {
  const future = { schema: SCHEMA + 1, entries: [], mysteryField: 'from a later build' };
  const r = migrate(future);
  assert.equal(r.ok, false);
  assert.equal(r.record, null, 'nothing is returned, so nothing can be written back over it');
  assert.match(r.reason, /Update the app/);
});

test('a record with no schema is treated as version 1 rather than rejected', () => {
  const r = migrate({ entries: [{ id: 'A', name: 'Entry A' }] });
  assert.equal(r.ok, true);
  assert.equal(r.from, 1);
});

test('the app runs on defaults when the stored record is from the future', async () => {
  ls.setItem('deadpool.state.v1', JSON.stringify({ schema: SCHEMA + 5 }));
  const s = await freshStore();
  const state = s.load();
  assert.ok(state.blocked, 'and it says why');
  assert.equal(state.entries.length, 2);
});

/* ------------------------------------------------------ backup / cache -- */

test('merge adds only what is missing, so an old backup cannot roll a week back', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'BUF' });
  const r = s.importAll({ app: 'deadpool', schema: SCHEMA, picks: [
    pick({ week: 1, team: 'KC', result: 'win' }),
    pick({ week: 2, team: 'SF', result: 'win' }),
  ] }, { mode: 'merge' });
  assert.equal(r.ok, true);
  assert.equal(s.pickAtWeek('A', 1).team, 'BUF', 'week 1 was already decided here and stays decided');
  assert.equal(s.pickAtWeek('A', 2).team, 'SF');
});

test('replace is replace', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'BUF' });
  s.importAll({ app: 'deadpool', schema: SCHEMA, picks: [pick({ week: 1, team: 'KC' })] }, { mode: 'replace' });
  assert.equal(s.pickAtWeek('A', 1).team, 'KC');
});

test('a file that is not a backup is refused by name', async () => {
  const s = await freshStore(); s.load();
  assert.match(s.importAll({ some: 'other json' }).reason, /not a Deadpool backup/);
});

test('the cache is evicted before the picks are, when space runs out', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  for (let w = 1; w <= 12; w += 1) s.writeCache('week', 2026, w, { games: [{ w }] });

  assert.equal(s.getPicks().length, 1, 'picks are never evicted');
  // _raw is a Map. Object.keys on it returns nothing, which made an earlier
  // version of this assertion pass against an empty list.
  const weeks = [...ls._raw.keys()].filter((k) => k.startsWith('deadpool.cache.v1.week.'));
  assert.equal(weeks.length, 8, `kept ${weeks.length} cached weeks, expected exactly 8`);
  assert.ok(weeks.includes('deadpool.cache.v1.week.2026.12'), 'the newest week survives');
  assert.ok(!weeks.includes('deadpool.cache.v1.week.2026.01'), 'the oldest is what gives way');
});

test('erasing removes every key the app owns and nothing else', async () => {
  ls.setItem('somebody-elses-key', 'keep me');
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  s.writeCache('week', 2026, 1, { games: [] });
  s.eraseAll();
  assert.equal(s.getPicks().length, 0);
  assert.equal(ls.getItem('somebody-elses-key'), 'keep me');
});

/**
 * The cache and the pick log share one alarm, and only one of them is a
 * person's own record. These four pin which of the two wins.
 */
const seedCache = (s, weeks = 8, pad = 'x'.repeat(300)) => {
  for (let w = 1; w <= weeks; w += 1) s.writeCache('week', 2026, w, { pad });
  return pad;
};

test('a cache write that recovers does not take a failed pick down with it', async () => {
  // Tight enough that the pick log will not fit, but a cached week will once
  // one older week is dropped -- which is a device somebody really has.
  installLocalStorage({ quota: 2900 });
  const s = await freshStore(); s.load();
  const pad = seedCache(s);

  const { ok } = s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  assert.equal(ok, false, 'the pick did not save');
  assert.equal(s.storage.currentAlarm().kind, 'full');

  const raised = s.storage.currentAlarm();
  assert.equal(s.writeCache('week', 2026, 9, { pad }), true, 'the cache recovers by evicting');
  assert.strictEqual(s.storage.currentAlarm(), raised,
    'the pick is still unsaved, so the screen must still say so -- and say the same thing');
});

test('a cache write that fails outright still does not mask a failed pick', async () => {
  installLocalStorage({ quota: 2900 });
  const s = await freshStore(); s.load();
  seedCache(s);

  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  const raised = s.storage.currentAlarm();

  // Far too big to fit even after an eviction.
  assert.equal(s.writeCache('week', 2026, 9, { pad: 'y'.repeat(5000) }), false);
  assert.strictEqual(s.storage.currentAlarm(), raised,
    'the pick is the more important message and is what stays on screen');
});

test('with nothing else wrong, a recovered cache write clears its own alarm', async () => {
  installLocalStorage({ quota: 2900 });
  const s = await freshStore(); s.load();
  const pad = seedCache(s);

  assert.equal(s.storage.currentAlarm(), null);
  assert.equal(s.writeCache('week', 2026, 9, { pad }), true);
  assert.equal(s.storage.currentAlarm(), null,
    'the cache refetches next time, so its own hiccup is not worth a banner');
});

test('on a store that refuses everything, the pick alarm is the one left standing', async () => {
  // Safari's private mode, where eviction cannot help because nothing writes.
  installLocalStorage({ blocked: true });
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  const raised = s.storage.currentAlarm();
  assert.equal(raised.kind, 'blocked');

  assert.equal(s.writeCache('week', 2026, 1, { games: [] }), false);
  assert.strictEqual(s.storage.currentAlarm(), raised);
});

test('a cache write that succeeds first time never touches a standing alarm', async () => {
  const ls2 = installLocalStorage();
  ls2._poison('deadpool.picks.v1', '{not json');
  const s = await freshStore();
  s.load();
  const raised = s.storage.currentAlarm();
  assert.equal(raised.kind, 'unreadable', 'the quarantine is what is on screen');

  assert.equal(s.writeCache('week', 2026, 1, { games: [] }), true, 'plenty of room');
  assert.strictEqual(s.storage.currentAlarm(), raised,
    'a cache write that never failed has nothing to say about it');
});
