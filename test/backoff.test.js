/**
 * The retry policy, which nothing else can execute.
 *
 * app.js has no coverage — `node --test` has no DOM — so the decision about
 * when to knock on ESPN again lived somewhere no test could reach. These are
 * the three ways this kind of code goes wrong quietly: an off-by-one into the
 * delay table, a cap that does not cap, and a counter that never resets after
 * the outage clears.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { BACKOFF_MS, delayFor, afterAttempt, shouldSkip } from '../deadpool/src/data/backoff.js';

test('the first failure waits a minute, not zero and not the cap', () => {
  // Off by one in either direction is silent: one way retries immediately and
  // the backoff does nothing, the other jumps straight to half an hour on a
  // single blip.
  assert.equal(delayFor(1), 60_000);
  assert.equal(delayFor(2), 300_000);
  assert.equal(delayFor(3), 900_000);
  assert.equal(delayFor(4), 1_800_000);
});

test('the wait stops growing at the cap rather than running off the table', () => {
  // Reading past the end of BACKOFF_MS gives undefined, and `now + undefined`
  // is NaN — which compares false against everything, so the backoff would
  // silently stop applying at exactly the point an outage is longest.
  for (const n of [5, 9, 100, 10_000]) {
    assert.equal(delayFor(n), BACKOFF_MS[BACKOFF_MS.length - 1],
      `${n} consecutive failures should hold at the cap`);
  }
  const late = afterAttempt({ failures: 99 }, false, 1_000);
  assert.ok(Number.isFinite(late.retryAfter), 'retryAfter must stay a real number');
  assert.equal(late.retryAfter, 1_000 + 1_800_000);
});

test('no failures means no wait', () => {
  assert.equal(delayFor(0), 0);
  assert.equal(delayFor(-1), 0);
  assert.equal(delayFor(NaN), 0);
});

test('one success clears the whole streak', () => {
  // Otherwise a bad afternoon leaves the device backing off into the evening
  // after the outage has cleared, which is the failure nobody notices because
  // the app looks fine — just stale.
  const backedOff = afterAttempt(afterAttempt({ failures: 2 }, false, 0), false, 0);
  assert.equal(backedOff.failures, 4);
  const recovered = afterAttempt(backedOff, true, 999);
  assert.deepEqual(recovered, { failures: 0, retryAfter: 0 });
});

test('a refresh inside the window is skipped, and outside it is not', () => {
  const state = afterAttempt({ failures: 0 }, false, 1_000);   // retryAfter = 61_000
  assert.equal(shouldSkip(state, 60_999), true, 'a millisecond early still waits');
  assert.equal(shouldSkip(state, 61_000), false, 'at the boundary it may go');
  assert.equal(shouldSkip(state, 999_999), false);
});

test('the manual retry always goes through', () => {
  // The one case that must never be blocked: somebody has been told the board
  // is stale and has tapped the button. Making them wait out a timer they
  // cannot see reads as the app being broken.
  const state = afterAttempt({ failures: 3 }, false, 0);
  assert.equal(shouldSkip(state, 1), true, 'a background refresh waits');
  assert.equal(shouldSkip(state, 1, true), false, 'the button does not');
});

test('a fresh state never skips', () => {
  assert.equal(shouldSkip({ failures: 0, retryAfter: 0 }, 0), false);
  assert.equal(shouldSkip(undefined, 12_345), false);
});
