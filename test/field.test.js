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

/* ------------------------------------------------------- loading the sheet -- */

/**
 * `loadPool` reads the response body itself rather than going through
 * `getJson`, because three of /api/pool's four answers are not errors and each
 * needs its own sentence. That is right, and it cost the cache fallback that
 * `getJson` throwing had provided for free — so these hold the line.
 */
test('a 200 carrying ok:false keeps the sheet already on the device', async () => {
  const { installLocalStorage, freshStore } = await import('./helpers/local-storage.js');
  installLocalStorage();
  const store = await freshStore();
  const sheet = { configured: true, ok: true, alive: 9, entries: 12, weeks: [1], inventories: { A: ['KC'] }, popularity: { 1: { KC: 1 } }, problems: [] };
  store.writeCache('pool', 2026, null, sheet);

  const source = await import('../deadpool/src/data/source.js');
  // The dangerous answer: the edge is reachable and says the sheet is not.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ configured: true, ok: false, error: 'not-csv' }) });

  const seen = [];
  const payload = await source.loadPool(2026, (p) => seen.push(p));

  assert.equal(payload.ok, true, 'the cached sheet survives');
  assert.equal(payload.alive, 9);
  assert.equal(payload.source, 'offline', 'and is not presented as current');
  assert.equal(payload.error, 'not-csv', 'with the reason carried');
  assert.ok(seen.every((p) => p.alive === 9), 'the screen is never handed the failure over good data');
});

test('a failure with nothing cached names the failure', async () => {
  const { installLocalStorage, freshStore } = await import('./helpers/local-storage.js');
  installLocalStorage();
  await freshStore();

  const source = await import('../deadpool/src/data/source.js');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ configured: true, ok: false, error: 'not-csv' }) });

  const payload = await source.loadPool(2026);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'not-csv');
  assert.equal(payload.source, 'none');
  assert.match(source.describePool(payload).text, /not readable without signing in/);
});

test('an unconfigured deployment with nothing cached says so, not "empty"', async () => {
  const { installLocalStorage, freshStore } = await import('./helpers/local-storage.js');
  installLocalStorage();
  await freshStore();

  const source = await import('../deadpool/src/data/source.js');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ configured: false, reason: 'POOL_SHEET_URL is not set' }) });

  const payload = await source.loadPool(2026);
  assert.equal(payload.configured, false);
  assert.match(source.describePool(payload).text, /No pool sheet is configured/);
});

test('a good sheet is cached and reported live', async () => {
  const { installLocalStorage, freshStore } = await import('./helpers/local-storage.js');
  installLocalStorage();
  const store = await freshStore();

  const source = await import('../deadpool/src/data/source.js');
  const sheet = { configured: true, ok: true, alive: 5, entries: 6, weeks: [1], inventories: {}, popularity: {}, problems: [] };
  globalThis.fetch = async () => ({ ok: true, json: async () => sheet });

  const payload = await source.loadPool(2026);
  assert.equal(payload.source, 'live');
  assert.equal(store.readCache('pool', 2026).alive, 5, 'and written to the cache');
});

test('a thrown fetch falls back to the cache, as it always did', async () => {
  const { installLocalStorage, freshStore } = await import('./helpers/local-storage.js');
  installLocalStorage();
  const store = await freshStore();
  store.writeCache('pool', 2026, null, { configured: true, ok: true, alive: 7, entries: 8, weeks: [1], inventories: {}, popularity: {}, problems: [] });

  const source = await import('../deadpool/src/data/source.js');
  globalThis.fetch = async () => { throw new Error('offline'); };

  const payload = await source.loadPool(2026);
  assert.equal(payload.alive, 7);
  assert.equal(payload.source, 'offline');
});

/* --------------------------------------------------- the field-aware one -- */

/**
 * `leverage`, from the JS side.
 *
 * Parity holds it to the Python across ten runs, including the forecast floats.
 * What parity cannot say is the thing this strategy is *shipped* on: that with
 * no sheet it is `distinct` exactly, and that the field can never walk both
 * entries onto one team. Those are asserted here.
 */
const BOARD = [
  {
    eventId: '1', week: 1, seasonYear: 2026, seasonType: 2, state: 'pre',
    startDate: '2026-09-13T17:00:00Z',
    home: { abbreviation: 'KC', displayName: 'Kansas City' },
    away: { abbreviation: 'DEN', displayName: 'Denver' },
    probability: null,
    odds: { provider: 't', spread: -7.5, details: 'KC -7.5', homeMoneyline: -320, awayMoneyline: 260, favoriteAbbreviation: 'KC' },
  },
  {
    eventId: '2', week: 1, seasonYear: 2026, seasonType: 2, state: 'pre',
    startDate: '2026-09-13T17:00:00Z',
    home: { abbreviation: 'BUF', displayName: 'Buffalo' },
    away: { abbreviation: 'NYJ', displayName: 'New York' },
    probability: null,
    odds: { provider: 't', spread: -7, details: 'BUF -7', homeMoneyline: -300, awayMoneyline: 245, favoriteAbbreviation: 'BUF' },
  },
  {
    eventId: '3', week: 1, seasonYear: 2026, seasonType: 2, state: 'pre',
    startDate: '2026-09-13T17:00:00Z',
    home: { abbreviation: 'SF', displayName: 'San Francisco' },
    away: { abbreviation: 'ARI', displayName: 'Arizona' },
    probability: null,
    odds: { provider: 't', spread: -6.5, details: 'SF -6.5', homeMoneyline: -280, awayMoneyline: 230, favoriteAbbreviation: 'SF' },
  },
];

const engineOf = async () => import('../deadpool/src/engine/index.js');
const levOf = async () => import('../deadpool/src/engine/strategies/leverage.js');
const distinctOf = async () => import('../deadpool/src/engine/strategies/distinct.js');

const ORDER = ['Entry A', 'Entry B'];
const USED = { 'Entry A': [], 'Entry B': [] };

async function tables() {
  const { buildWinProbabilityTable } = await engineOf();
  return buildWinProbabilityTable(BOARD);
}

test('with no field, leverage is distinct exactly — the same pick, not a similar one', async () => {
  const { recommendLeverage } = await levOf();
  const { recommendDistinct } = await distinctOf();
  const table = await tables();

  for (const inventories of [{}, undefined]) {
    const lev = recommendLeverage(BOARD, table, 1, { ...USED }, ORDER, inventories);
    const dist = recommendDistinct(BOARD, table, 1, { ...USED }, ORDER);
    assert.deepEqual(
      Object.fromEntries(Object.entries(lev.picks).map(([e, p]) => [e, p?.teamAbbreviation])),
      Object.fromEntries(Object.entries(dist.picks).map(([e, p]) => [e, p?.teamAbbreviation])),
    );
    assert.deepEqual(lev.switched, {}, 'nothing can have moved');
    assert.deepEqual(lev.forecast, {}, 'and there is no forecast to have moved it');
  }
});

test('the two entries never land together, whatever the field says', async () => {
  const { recommendLeverage } = await levOf();
  const table = await tables();
  // Several shapes of crowding, including ones that make one team look like
  // the obviously least-crowded answer for both entries at once.
  for (const spent of [['KC'], ['BUF'], ['KC', 'BUF'], ['SF'], ['KC', 'SF']]) {
    const inventories = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`e${i}`, spent]),
    );
    const lev = recommendLeverage(BOARD, table, 1, { ...USED }, ORDER, inventories);
    const teams = Object.values(lev.picks).filter(Boolean).map((p) => p.teamAbbreviation);
    assert.equal(new Set(teams).size, teams.length, `collision with ${spent}: ${teams}`);
  }
});

test('a move never gives up more than the tolerance', async () => {
  const { recommendLeverage } = await levOf();
  const { recommendDistinct } = await distinctOf();
  const table = await tables();
  const inventories = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`e${i}`, ['KC']]));

  for (const tolerancePct of [0.5, 2, 5]) {
    const lev = recommendLeverage(BOARD, table, 1, { ...USED }, ORDER, inventories, { tolerancePct, minGain: 0 });
    const dist = recommendDistinct(BOARD, table, 1, { ...USED }, ORDER);
    for (const entry of ORDER) {
      const after = lev.picks[entry];
      const before = dist.picks[entry];
      if (!after || !before) continue;
      assert.ok(after.winPct >= before.winPct - tolerancePct - 1e-9,
        `${entry} gave up ${(before.winPct - after.winPct).toFixed(2)} at tolerance ${tolerancePct}`);
    }
  }
});

test('a minimum gain of zero is the first version, and is reachable', async () => {
  // Kept reachable on purpose: it is what `lev-g0` races in the backtest. The
  // race did not separate the two on pot share -- t = 0.64 over 10,000 seasons
  // -- so what this asserts is the structural difference the parameter exists
  // for, which is that it moves less often, and not a measured edge.
  const { recommendLeverage, DEFAULT_MIN_GAIN } = await levOf();
  const table = await tables();
  const inventories = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`e${i}`, []]));

  const greedy = recommendLeverage(BOARD, table, 1, { ...USED }, ORDER, inventories, { tolerancePct: 20, minGain: 0 });
  const shipped = recommendLeverage(BOARD, table, 1, { ...USED }, ORDER, inventories, { tolerancePct: 20, minGain: DEFAULT_MIN_GAIN });
  // On a board where nobody has spent anything, the crowding differences are
  // small, so the shipped minimum gain should move strictly less often.
  assert.ok(Object.keys(greedy.switched).length >= Object.keys(shipped.switched).length,
    'the gain threshold must not make it move more');
});

test('the forecast reaches the strategy the same way it reaches the view', async () => {
  const { recommendLeverage, forecastField } = await levOf();
  const table = await tables();
  const field = makeField(payload({
    inventories: { a: ['KC'], b: ['KC'], c: ['BUF'] },
  }));
  const direct = forecastField(BOARD, field);
  const lev = recommendLeverage(BOARD, table, 1, { ...USED }, ORDER, field.inventories);
  assert.deepEqual(lev.forecast, direct, 'the strategy and the view see one forecast');

  // Two of the three have spent KC, so its share is carried by the one that
  // has not — present and reduced, not absent.
  assert.ok(direct.KC > 0 && direct.KC < 1, `KC should be present and reduced, got ${direct.KC}`);

  // Absent is reserved for a team *no* surviving entry can take, which is a
  // different statement from "scored at zero" — the same distinction spentShare
  // holds above.
  const allSpent = makeField(payload({ inventories: { a: ['KC'], b: ['KC'], c: ['KC'] } }));
  const none = forecastField(BOARD, allSpent);
  assert.ok(!('KC' in none), 'nobody can take KC, so it never entered a choice');
});
