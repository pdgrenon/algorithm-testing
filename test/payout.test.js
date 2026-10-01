/**
 * What a pool this size is worth — and the settings that used to say nothing.
 *
 * `poolSize`, `buyIn` and `terminalRule` sat in the stored state from the first
 * version, were carried through `poolRules()`, and were read by nothing at all.
 * There was no control to edit them and no engine path that touched them. These
 * assertions are what makes them mean something, and the last group is the one
 * that matters most: a rating measured against 250 entries is not a rating for
 * a pool of 20, and the app now says so rather than letting the number imply
 * otherwise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_POOL_SIZE, DEFAULT_BUY_IN, PUBLIC_WEEKLY_SURVIVAL,
  potOf, fairShare, valueOf, expectedPerfectEntries, ratingCaveat,
} from '../deadpool/src/engine/payout.js';
import { RUN } from '../deadpool/src/engine/measured.js';

/* ------------------------------------------------------------- the pot -- */

test('the pot is the field times the buy-in', () => {
  assert.equal(potOf(250, 10), 2500);
  assert.equal(potOf(12, 25), 300);
});

test('a nonsensical pool or buy-in is floored rather than negative', () => {
  assert.equal(potOf(-5, 10), 0);
  assert.equal(potOf(250, -10), 0);
});

test('a fair share is one entry out of the field', () => {
  assert.equal(fairShare(250), 1 / 250);
  assert.equal(fairShare(20), 0.05);
});

test('a fair share of an empty pool is zero, not infinite', () => {
  assert.equal(fairShare(0), 0);
  assert.equal(fairShare(-1), 0);
});

test('a fair share is worth exactly the buy-in, which is the whole point', () => {
  // 1/250 of a $2,500 pot is $10 back on $10 staked. That identity is why
  // "1.72x fair" is a meaningful thing to print beside a strategy.
  for (const [size, buyIn] of [[250, 10], [12, 25], [1000, 5]]) {
    assert.equal(valueOf(fairShare(size), size, buyIn), buyIn);
  }
});

/* --------------------------------------------------- how a season ends -- */

test('a 250-entry pool expects under one perfect season', () => {
  // The fact that makes a second entry worth holding: below one, the pot
  // splits among whoever got deepest rather than among the unbeaten.
  const n = expectedPerfectEntries(250);
  assert.ok(n < 1, `expected under one, got ${n}`);
  assert.ok(Math.abs(n - 0.87) < 0.02, `the README says about 0.87, got ${n.toFixed(3)}`);
});

test('it matches the closed form it claims to be', () => {
  assert.ok(Math.abs(
    expectedPerfectEntries(500) - 500 * PUBLIC_WEEKLY_SURVIVAL ** 18,
  ) < 1e-9);
});

test('a big pool flips into the regime where perfect seasons are normal', () => {
  // Not a rounding detail: at 1,000 entries several finish unbeaten and the
  // pot is split among them, which changes what a second entry is worth.
  assert.ok(expectedPerfectEntries(1000) > 1);
  assert.ok(expectedPerfectEntries(30) < 0.2);
});

/* ------------------------------------------------------- the caveat --- */

test('a pool near the measured size gets no caveat', () => {
  // The ratings are a coarse ordering of six strategies; 240 against 250 does
  // not change it and a warning there would be noise. Relative to the run the
  // ratings came from, not a literal, because that run's pool size changes
  // when the table is re-measured.
  const at = RUN.poolSize;
  for (const size of [at, Math.round(at * 0.8), Math.round(at * 1.2), Math.round(at * 1.6), Math.ceil(at * 0.52)]) {
    assert.equal(ratingCaveat(size), null, `${size} should be close enough`);
  }
});

test('a pool far from the measured size says so', () => {
  // The README's own finding: the field size "is the whole of how to use it,
  // and it reverses the answer". A rating quoted at 250 in a 20-person pool
  // is not a rating for that pool.
  const small = ratingCaveat(20);
  assert.ok(small && small.includes('20'), 'names the actual pool size');
  assert.match(small, new RegExp(`measured against ${RUN.poolSize}`));

  const large = ratingCaveat(2000);
  assert.ok(large && large.includes('2000'));
  assert.match(large, new RegExp(`measured against ${RUN.poolSize}`));
});

test('the two directions say different things, because they are different', () => {
  // A small pool makes the ordering less reliable; a large one makes the gap
  // wider than reported. Collapsing them into one sentence would be wrong in
  // one of the two cases.
  assert.notEqual(ratingCaveat(20), ratingCaveat(2000));
  assert.match(ratingCaveat(20), /indicative/);
  assert.match(ratingCaveat(2000), /understated/);
});

test('a missing or absurd pool size produces no caveat rather than a crash', () => {
  for (const bad of [null, undefined, 0, -5, NaN, 'many']) {
    assert.equal(ratingCaveat(bad), null, `${String(bad)} should be ignored`);
  }
});

test('the caveat is measured against the run the ratings came from', () => {
  // It defaulted to DEFAULT_POOL_SIZE, which was right only while the app's
  // default and the backtest's pool were both 250. They are separate facts:
  // one is the pool you are in, the other is what was simulated.
  assert.equal(ratingCaveat(RUN.poolSize), null);
  assert.equal(ratingCaveat(RUN.poolSize * 3), ratingCaveat(RUN.poolSize * 3, RUN.poolSize));
});

test('the defaults are the ones the rest of the repository assumes', () => {
  // This pool, off its own sheet; config.py's POOL_SIZE says the same.
  assert.equal(DEFAULT_POOL_SIZE, 378);
  assert.equal(DEFAULT_BUY_IN, 10);
  assert.equal(PUBLIC_WEEKLY_SURVIVAL, 0.73);
});
