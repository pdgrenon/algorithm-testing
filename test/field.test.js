/**
 * The field: what the pool's own sheet says about everybody else.
 *
 * Two things are being guarded here and they are not the same thing.
 *
 * The first is ordinary: the shapes come out right. The second is the reason
 * this module exists at all — that **exact and estimated stay apart**.
 * Inventories are a fact and popularity is a record of weeks already played,
 * and the single most expensive bug available in this file is one that lets
 * the second be read as a forecast of the week being decided. Several of the
 * assertions below exist only to hold that line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_FIELD, makeField, spentShare, spentShareOf,
  stillAvailableTo, observedPopularity, observedChalkiness,
} from '../deadpool/src/engine/field.js';

/** A parsed sheet the way /api/pool hands one over. */
const payload = ({ alive = 3, entries = 4, inventories = {}, popularity = {}, weeks = [1, 2], problems = [] } = {}) => ({
  configured: true,
  ok: true,
  alive,
  entries,
  weeks,
  inventories,
  popularity,
  problems,
  latestWeek: weeks.length ? Math.max(...weeks) : null,
});

const THREE = payload({
  inventories: {
    'Gridiron Gang': ['KC', 'BUF'],
    'Ship of Theseus': ['KC', 'PHI'],
    'Last Man Standing': ['KC', 'SF'],
  },
  popularity: { 1: { KC: 1 }, 2: { BUF: 0.34, PHI: 0.33, SF: 0.33 } },
});

/* ------------------------------------------------------------- the empty -- */

test('every way of having no sheet lands on the same value', () => {
  for (const [what, input] of [
    ['nothing at all', null],
    ['undefined', undefined],
    ['not configured', { configured: false, reason: 'POOL_SHEET_URL is not set' }],
    ['a sheet that would not open', { configured: true, ok: false, error: 'not-csv' }],
    ['a sheet that was unreachable', { configured: true, ok: false, error: 'unreachable' }],
  ]) {
    assert.equal(makeField(input), EMPTY_FIELD, `${what} should give EMPTY_FIELD`);
  }
});

test('EMPTY_FIELD has every key a full one does, so no consumer null-checks', () => {
  const full = makeField(THREE);
  assert.deepEqual(Object.keys(EMPTY_FIELD).sort(), Object.keys(full).sort());
});

test('EMPTY_FIELD is frozen all the way down', () => {
  assert.ok(Object.isFrozen(EMPTY_FIELD));
  assert.ok(Object.isFrozen(EMPTY_FIELD.inventories));
  assert.ok(Object.isFrozen(EMPTY_FIELD.popularity));
  assert.ok(Object.isFrozen(EMPTY_FIELD.weeks));
});

test('an unconfigured field is distinguishable from a configured empty one', () => {
  // Both draw nothing, and they want completely different sentences: one is
  // "set POOL_SHEET_URL", the other is "the season has not started".
  assert.equal(makeField({ configured: false }).configured, false);
  const started = makeField(payload({ inventories: {}, popularity: {}, weeks: [] }));
  assert.equal(started.configured, true);
  assert.equal(started.observed, false);
});

/* ------------------------------------------------------------- the shape -- */

test('a parsed sheet comes through with its counts intact', () => {
  const f = makeField(THREE);
  assert.equal(f.configured, true);
  assert.equal(f.observed, true);
  assert.equal(f.alive, 3);
  assert.equal(f.total, 4);
  assert.deepEqual(f.weeks, [1, 2]);
});

test('the whole field is frozen, because a strategy is handed it', () => {
  const f = makeField(THREE);
  assert.ok(Object.isFrozen(f));
  assert.ok(Object.isFrozen(f.inventories));
  assert.ok(Object.isFrozen(f.inventories['Gridiron Gang']));
  assert.ok(Object.isFrozen(f.popularity));
  assert.ok(Object.isFrozen(f.popularity[1]));
});

test('an inventory is deduplicated and sorted, so two sheets agreeing compare equal', () => {
  const f = makeField(payload({ inventories: { A: ['SF', 'KC', 'KC', 'BUF'] } }));
  assert.deepEqual(f.inventories.A, ['BUF', 'KC', 'SF']);
});

test('popularity weeks come back as numbers, not the strings JSON made of them', () => {
  const f = makeField(THREE);
  // JSON object keys are strings; every caller indexes by a numeric week.
  assert.ok(1 in f.popularity, 'week 1 should be reachable by number');
  assert.deepEqual(Object.keys(f.popularity).map(Number).sort((a, b) => a - b), [1, 2]);
});

test('a week with no picks is dropped rather than counted as an observation', () => {
  // The endpoint sends one entry per week on the sheet, including weeks that
  // have not been played. Keeping those would make latestWeek run ahead of
  // what anybody has actually done.
  const f = makeField(payload({ weeks: [1, 2, 3], popularity: { 1: { KC: 1 }, 2: {}, 3: {} } }));
  assert.deepEqual(Object.keys(f.popularity).map(Number), [1]);
  assert.equal(f.latestWeek, 1);
});

/* --------------------------------------------------------------- spent -- */

test('spentShare is the share of SURVIVORS, not of the original field', () => {
  // Three alive out of four entries; KC is on all three inventories. The
  // answer is 1, not 0.75 -- a dead entry's inventory constrains nobody.
  const shares = spentShare(makeField(THREE));
  assert.equal(shares.KC, 1);
});

test('spentShare divides by the right denominator', () => {
  const shares = spentShare(makeField(THREE));
  assert.equal(shares.BUF, 1 / 3);
  assert.equal(shares.PHI, 1 / 3);
  assert.equal(shares.SF, 1 / 3);
});

test('a team nobody has spent is absent, and reads 0 when asked', () => {
  const shares = spentShare(makeField(THREE));
  assert.equal(shares.DAL, undefined, 'absent rather than a fabricated zero');
  assert.equal(spentShareOf(shares, 'DAL'), 0, 'and 0 through the accessor');
});

test('spentShare on an empty field is empty rather than a division by zero', () => {
  assert.deepEqual(spentShare(EMPTY_FIELD), {});
  assert.deepEqual(spentShare(null), {});
  assert.equal(spentShareOf(spentShare(EMPTY_FIELD), 'KC'), 0);
});

test('stillAvailableTo counts the survivors who could still take a team', () => {
  const f = makeField(THREE);
  assert.equal(stillAvailableTo(f, 'KC'), 0, 'everyone has spent KC');
  assert.equal(stillAvailableTo(f, 'BUF'), 2, 'two of three still hold BUF');
  assert.equal(stillAvailableTo(f, 'DAL'), 3, 'nobody has spent DAL');
});

test('stillAvailableTo and spentShare are complements, on every team', () => {
  const f = makeField(THREE);
  const survivors = Object.keys(f.inventories).length;
  const shares = spentShare(f);
  for (const team of ['KC', 'BUF', 'PHI', 'SF', 'DAL']) {
    // To a tolerance, not exactly: the two arrive at the same quantity by
    // different arithmetic (2/3 against 1 - 1/3) and those differ in the last
    // bit of a double. The invariant is real; demanding bit-equality of it
    // would be asserting something about IEEE 754 rather than about the pool.
    assert.ok(
      Math.abs(stillAvailableTo(f, team) / survivors - (1 - spentShareOf(shares, team))) < 1e-12,
      `${team} should agree between the two`,
    );
  }
});

/* ---------------------------------------------------------- popularity -- */

test('popularity answers only for weeks that have been played', () => {
  const f = makeField(THREE);
  assert.deepEqual(observedPopularity(f, 1), { KC: 1 });
  assert.deepEqual(observedPopularity(f, 2), { BUF: 0.34, PHI: 0.33, SF: 0.33 });
});

test('the current week and an unknown week give the same empty answer', () => {
  // This is the load-bearing one. A caller must not be able to tell "week 3
  // has not happened" from "week 99 is not a week", because a caller that
  // could would be a caller reaching for picks that are not visible yet.
  const f = makeField(THREE);
  assert.deepEqual(observedPopularity(f, 3), {});
  assert.deepEqual(observedPopularity(f, 99), {});
  assert.deepEqual(observedPopularity(EMPTY_FIELD, 1), {});
});

test('popularity takes a numeric or a string week, since views pass both', () => {
  const f = makeField(THREE);
  assert.deepEqual(observedPopularity(f, '1'), { KC: 1 });
});

/* ---------------------------------------------------------- chalkiness -- */

test('chalkiness is the mean of each week top share', () => {
  // Week 1 everybody on KC (1.0); week 2 split three ways (top 0.34).
  assert.equal(observedChalkiness(makeField(THREE)), (1 + 0.34) / 2);
});

test('chalkiness is null when nothing has been observed, not a neutral 0.5', () => {
  // A made-up midpoint would read as a measurement on a screen, which is the
  // one thing this codebase refuses to do.
  assert.equal(observedChalkiness(EMPTY_FIELD), null);
  assert.equal(observedChalkiness(makeField(payload({ popularity: {} }))), null);
});

test('a pool where everyone piles on scores higher than one that spreads out', () => {
  const chalky = makeField(payload({ popularity: { 1: { KC: 0.9, SF: 0.1 } } }));
  const spread = makeField(payload({ popularity: { 1: { KC: 0.3, SF: 0.3, BUF: 0.4 } } }));
  assert.ok(observedChalkiness(chalky) > observedChalkiness(spread));
});

/* ------------------------------------------------------------ problems -- */

test('parser complaints travel with the field rather than being swallowed', () => {
  const f = makeField(payload({ problems: ['row 7: no entry name; skipped'] }));
  assert.deepEqual(f.problems, ['row 7: no entry name; skipped']);
  assert.ok(Object.isFrozen(f.problems));
});

/* ----------------------------------------------------- on the context -- */

test('makeContext carries a field, and defaults it rather than leaving it null', async () => {
  const { makeContext } = await import('../deadpool/src/engine/index.js');
  const bare = makeContext({ season: 2026, week: 1 });
  assert.equal(bare.field, EMPTY_FIELD, 'a context built without one still has one');
  assert.ok(Object.isFrozen(bare.field));

  const withField = makeContext({ season: 2026, week: 1, field: makeField(THREE) });
  assert.equal(withField.field.alive, 3);
});

test('an explicit null field falls back rather than reaching a strategy', () => {
  // app.js passes `live.pool ? makeField(...) : EMPTY_FIELD`, but a caller in a
  // test or a future view may well pass through a null. A strategy reading
  // ctx.field.observed must not throw because of one.
  return import('../deadpool/src/engine/index.js').then(({ makeContext }) => {
    assert.equal(makeContext({ season: 2026, week: 1, field: null }).field, EMPTY_FIELD);
  });
});

test('provenance sits beside the field, never inside it', async () => {
  const { makeContext } = await import('../deadpool/src/engine/index.js');
  const ctx = makeContext({ season: 2026, week: 1, field: makeField(THREE), fieldSource: 'cache' });
  assert.equal(ctx.fieldSource, 'cache');
  // The whole point: a strategy reading ctx.field cannot discover how old it
  // is, so it cannot make a decision that fails to replay.
  assert.ok(!('fetchedAt' in ctx.field), 'the field must not carry a fetch time');
  assert.ok(!('source' in ctx.field), 'nor a freshness');
});

test('every registered strategy still runs with a field present, and ignores it', async () => {
  const { makeContext, listStrategies, run } = await import('../deadpool/src/engine/index.js');
  const games = [{
    eventId: '1', week: 1, seasonYear: 2026, seasonType: 2, state: 'pre',
    startDate: '2026-09-13T17:00:00Z',
    home: { abbreviation: 'KC', displayName: 'Kansas City', score: null, winner: null },
    away: { abbreviation: 'BUF', displayName: 'Buffalo', score: null, winner: null },
    probability: null,
    odds: { provider: 't', spread: -6.5, details: 'KC -6.5', homeMoneyline: -280, awayMoneyline: 230, favoriteAbbreviation: 'KC' },
  }];

  for (const s of listStrategies()) {
    const without = run(s.id, makeContext({ season: 2026, week: 1, games }));
    const with_ = run(s.id, makeContext({ season: 2026, week: 1, games, field: makeField(THREE) }));
    assert.ok(without.ok, `${s.id} should run without a field`);
    assert.ok(with_.ok, `${s.id} should run with one`);
    // None of the six reads the field yet. When one does, this assertion is
    // the thing that should be changed deliberately rather than discovered.
    assert.deepEqual(
      with_.picks.map((p) => p.candidate?.teamAbbreviation),
      without.picks.map((p) => p.candidate?.teamAbbreviation),
      `${s.id} changed its picks because of field data it does not claim to read`,
    );
  }
});
