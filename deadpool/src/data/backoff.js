/**
 * When to stop knocking on an upstream that is not answering.
 *
 * ESPN's endpoints are undocumented and unsupported. The least a client can do
 * is not retry at a fixed interval through an outage — and `app.js` calls
 * `refresh()` on every tab focus, so a phone picked up and put down twenty
 * times during a bad hour was twenty attempts.
 *
 * HTTP caching already blunts that: a failed board ships `max-age=60`, so
 * repeats inside a minute never leave the device. But that is a flat minute
 * forever, and a flat interval is exactly what a service having a bad hour
 * does not need.
 *
 * ── Why this is a module and not four lines in app.js ───────────────────
 *
 * Because `node --test` has no DOM, so app.js is not covered by anything —
 * see CLAUDE.md. A retry policy that nothing can execute is a retry policy
 * nobody can check, and this one has exactly the shape that goes wrong
 * quietly: off-by-one into the delay table, a cap that does not cap, a
 * counter that never resets after recovery. All three are cheap to assert and
 * impossible to see by reading.
 */

/**
 * How long to wait after N consecutive failures, in milliseconds.
 *
 * A minute, then five, then fifteen, then half an hour. Capped rather than
 * unbounded: an outage that outlasts the cap is one where checking twice an
 * hour is both polite and still useful, and a backoff that grows forever
 * eventually stops being a refresh at all.
 */
export const BACKOFF_MS = Object.freeze([60_000, 300_000, 900_000, 1_800_000]);

/** The delay owed after `failures` consecutive failures. Clamped at both ends. */
export function delayFor(failures) {
  if (!Number.isFinite(failures) || failures <= 0) return 0;
  return BACKOFF_MS[Math.min(Math.trunc(failures), BACKOFF_MS.length) - 1];
}

/**
 * The next state after an attempt.
 *
 * `failures` counts consecutive failures and resets to zero the moment
 * anything answers, so one bad afternoon does not leave a device backing off
 * into the evening after the outage has cleared.
 */
export function afterAttempt(state, ok, now) {
  if (ok) return { failures: 0, retryAfter: 0 };
  const failures = Math.min((state?.failures ?? 0) + 1, BACKOFF_MS.length);
  return { failures, retryAfter: now + delayFor(failures) };
}

/**
 * Should this refresh be skipped?
 *
 * `force` is what the "Try again" button passes. Somebody who has just been
 * told the data is stale and tapped the button is not the traffic this is
 * protecting against, and making them wait out a timer they cannot see is the
 * kind of politeness that reads as a bug.
 */
export function shouldSkip(state, now, force = false) {
  if (force) return false;
  return Boolean(state?.retryAfter) && now < state.retryAfter;
}
