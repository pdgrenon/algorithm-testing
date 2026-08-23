/**
 * Why the upstream failed, not just that it did.
 *
 * `fetchJson` collapses a refusal, a timeout, malformed JSON and a transport
 * error into `null`, and the Function reported all four as "ESPN did not
 * answer". That is the right sentence for a person and useless for anybody
 * fixing a deployment -- establishing that a live upstream was *refusing*
 * rather than timing out took six round trips of guessing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchUpstream, fetchJson, json } from '../deadpool/functions/api/_shared.js';

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('a refusal carries the status the upstream chose', async () => {
  // The case that actually happened: Akamai answering 403 to the Function's
  // User-Agent while the same URL returns 200 to curl.
  const got = await withFetch(
    async () => new Response('<html>Access Denied</html>', { status: 403 }),
    () => fetchUpstream('https://example.test/x'),
  );
  assert.equal(got.reason, 'refused');
  assert.equal(got.status, 403);
  assert.equal(got.body, null);
});

test('a body that is not JSON is malformed, not refused', async () => {
  // 200 with an HTML block page is a different fault from a 403, and the two
  // want different fixes.
  const got = await withFetch(
    async () => new Response('<html>hello</html>', { status: 200 }),
    () => fetchUpstream('https://example.test/x'),
  );
  assert.equal(got.reason, 'malformed');
  assert.equal(got.status, 200);
});

test('an abort is a timeout rather than a transport error', async () => {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  const got = await withFetch(async () => { throw err; }, () => fetchUpstream('https://example.test/x'));
  assert.equal(got.reason, 'timeout');
  assert.equal(got.status, null);
});

test('anything else is transport', async () => {
  const got = await withFetch(
    async () => { throw new TypeError('getaddrinfo ENOTFOUND'); },
    () => fetchUpstream('https://example.test/x'),
  );
  assert.equal(got.reason, 'transport');
});

test('success carries the body and no reason', async () => {
  const got = await withFetch(
    async () => new Response(JSON.stringify({ events: [] }), { status: 200 }),
    () => fetchUpstream('https://example.test/x'),
  );
  assert.deepEqual(got.body, { events: [] });
  assert.equal(got.reason, null);
});

test('fetchJson still returns just the body, so its callers are unchanged', async () => {
  const ok = await withFetch(
    async () => new Response(JSON.stringify({ a: 1 }), { status: 200 }),
    () => fetchJson('https://example.test/x'),
  );
  assert.deepEqual(ok, { a: 1 });
  const bad = await withFetch(
    async () => new Response('nope', { status: 500 }),
    () => fetchJson('https://example.test/x'),
  );
  assert.equal(bad, null);
});

/* ------------------------------------------------------------ json() -- */

test('json() names the TTL it was given, and refuses one it was not', () => {
  // `{ maxAge: 900 }` was passed to this helper for the fallback board and
  // silently ignored -- json() takes `ttl`, and `maxAge` is the parameter of
  // the *other* json() in functions/api/pool.js. The response shipped at the
  // 300-second default for a quarter of the intended freshness with nothing
  // anywhere saying so, which is the failure this pair of assertions closes.
  const ok = json({ ok: true }, { ttl: 900 });
  assert.match(ok.headers.get('Cache-Control'), /max-age=900\b/);

  assert.throws(() => json({ ok: true }, { maxAge: 900 }), /does not take maxAge/);
});
