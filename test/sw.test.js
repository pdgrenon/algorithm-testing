/**
 * The service worker: what the app is when the network is not there.
 *
 * None of this was reachable from a test before — `stamp-sw.mjs` checks the
 * precache list and the version, and nothing checked the three handlers that
 * decide what a phone in a stadium actually renders.
 *
 * The load-bearing claim is the one at the top of sw.js: the precache is an
 * atomic snapshot, and that is what makes cache-first safe. Half these tests
 * exist to hold it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker, req, res, html } from './helpers/service-worker.js';

/** A network serving `version`, switchable mid-test to simulate a deploy. */
function server(version = 'v1') {
  const state = { version, down: false, hang: false, shell: null };
  const fetchImpl = async (request) => {
    if (state.down) throw new TypeError('Failed to fetch');
    if (state.hang) return new Promise(() => {});
    const path = new URL(request.url).pathname;
    if (path === '/' || path === '/index.html') {
      return state.shell ?? html(`<!doctype html><title>${state.version}</title>`);
    }
    if (path.startsWith('/api/')) return res(JSON.stringify({ ok: true, v: state.version }), { contentType: 'application/json' });
    return res(`${state.version}:${path}`);
  };
  return { state, fetchImpl };
}

const shellCacheName = async (w) => (await w.caches.keys()).find((k) => k.startsWith('deadpool-v1-'));
const bodyIn = async (w, name, url) => (await (await w.caches.open(name)).match(url))?.body;

/* ------------------------------------------------------------- install -- */

test('install precaches the whole shell under the stamped version', async () => {
  const { fetchImpl } = server();
  const w = await loadWorker(fetchImpl);
  await w.install();

  const name = await shellCacheName(w);
  assert.ok(name, 'the cache is named for the version stamp');
  const cache = await w.caches.open(name);
  const keys = await cache.keys();
  assert.ok(keys.length >= 40, `precached ${keys.length} entries`);
  assert.ok(keys.some((k) => k.endsWith('/index.html')));
  assert.ok(keys.some((k) => k.endsWith('/src/app.js')));
  assert.ok(keys.some((k) => k.endsWith('/src/store/storage.js')),
    'every shipped module belongs in the snapshot, not just the entry point');
});

/* ---------------------------------------------------- the atomic snapshot -- */

test('a navigation after a deploy does not put the new shell in the old snapshot', async () => {
  const { state, fetchImpl } = server('v1');
  const w = await loadWorker(fetchImpl);
  await w.install();
  const name = await shellCacheName(w);

  // A deploy lands. This worker is still the active one: the new version is
  // installing beside it and waiting for the page to accept a reload.
  state.version = 'v2';
  const nav = await w.fetch(req('/', { mode: 'navigate' }));
  assert.match(nav.body, /v2/, 'the fresh shell is still served — this is network-first');

  assert.match(await bodyIn(w, name, '/index.html'), /v1/,
    'but the snapshot keeps its own shell: a v2 index.html beside v1 modules is exactly '
    + 'the half-and-half state the file says cannot happen');
  assert.match(await bodyIn(w, name, '/src/app.js'), /v1/, 'and the modules are untouched');
});

test('the offline shell matches the modules it will run against', async () => {
  const { state, fetchImpl } = server('v1');
  const w = await loadWorker(fetchImpl);
  await w.install();

  state.version = 'v2';
  await w.fetch(req('/', { mode: 'navigate' }));      // online, after a deploy
  state.down = true;

  const nav = await w.fetch(req('/', { mode: 'navigate' }));
  const asset = await w.fetch(req('/src/app.js'));
  assert.match(nav.body, /v1/);
  assert.match(asset.body, /v1/);
  assert.equal(nav.body.match(/v\d/)[0], asset.body.match(/v\d/)[0],
    'one version, both halves — the whole point of the snapshot');
});

/* ---------------------------------------------------------- navigation -- */

test('a navigation with no network falls back to the cached shell', async () => {
  const { state, fetchImpl } = server();
  const w = await loadWorker(fetchImpl);
  await w.install();
  state.down = true;

  const nav = await w.fetch(req('/', { mode: 'navigate' }));
  assert.match(nav.body, /v1/, 'a white screen is the one thing this must never be');
});

test('a navigation that hangs gives up and paints the cached shell', async () => {
  const { state, fetchImpl } = server();
  const w = await loadWorker(fetchImpl);
  await w.install();
  state.hang = true;

  const started = process.hrtime.bigint();
  const nav = await w.fetch(req('/', { mode: 'navigate' }));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.match(nav.body, /v1/, 'half-connected stadium wifi is the case this exists for');
  assert.ok(ms < 6000, `waited ${Math.round(ms)}ms; the timer is meant to be 3s`);
});

test('a captive portal cannot overwrite the app', async () => {
  const { state, fetchImpl } = server();
  const w = await loadWorker(fetchImpl);
  await w.install();
  const name = await shellCacheName(w);

  // Airport wifi: 200, HTML, but a redirect to somebody else's login page.
  state.shell = html('<!doctype html><title>Sign in to WiFi</title>', { redirected: true });
  const nav = await w.fetch(req('/', { mode: 'navigate' }));

  assert.match(nav.body, /v1/, 'the cached app is served instead of the portal');
  assert.match(await bodyIn(w, name, '/index.html'), /v1/, 'and the portal never reaches the cache');
});

test('a 200 that is not HTML is not treated as the shell either', async () => {
  const { state, fetchImpl } = server();
  const w = await loadWorker(fetchImpl);
  await w.install();

  state.shell = res('not markup', { contentType: 'application/json' });
  const nav = await w.fetch(req('/', { mode: 'navigate' }));
  assert.match(nav.body, /v1/);
});

/* ----------------------------------------------------------------- api -- */

test('the api is network-first and keeps the last good answer', async () => {
  const { state, fetchImpl } = server();
  const w = await loadWorker(fetchImpl);

  const live = await w.fetch(req('/api/week?season=2026&week=3'));
  assert.match(live.body, /"v":"v1"/);

  state.down = true;
  const offline = await w.fetch(req('/api/week?season=2026&week=3'));
  assert.match(offline.body, /"v":"v1"/, 'the last good board is better than nothing');
});

test('a different week is not answered with the cached one', async () => {
  const { state, fetchImpl } = server();
  const w = await loadWorker(fetchImpl);

  await w.fetch(req('/api/week?season=2026&week=3'));
  state.down = true;
  const other = await w.fetch(req('/api/week?season=2026&week=4'));
  assert.equal(other.status, 503, 'week 4 was never fetched, so there is nothing honest to serve');
  assert.match(await other.text(), /"error":"offline"/);
});

test('an upstream failure is not cached as if it were a board', async () => {
  const w = await loadWorker(async () => res('{"ok":false}', { status: 502, contentType: 'application/json' }));

  const answer = await w.fetch(req('/api/week?week=3'));
  assert.equal(answer.status, 502, 'the caller still hears what went wrong');

  const apiCache = await w.caches.open('deadpool-api-v1');
  assert.deepEqual(await apiCache.keys(), [],
    'one bad minute at ESPN must not become hours of the app insisting there are no games');
});

/* ----------------------------------------------------------- lifecycle -- */

test('activate drops old snapshots but never the api cache', async () => {
  const { fetchImpl } = server();
  const w = await loadWorker(fetchImpl);
  await w.install();
  await w.fetch(req('/api/week?week=1'));            // populate the api cache
  await (await w.caches.open('deadpool-v1-stale')).put('/index.html', html('ancient'));

  await w.activate();

  const names = await w.caches.keys();
  assert.ok(!names.includes('deadpool-v1-stale'), 'the previous snapshot goes');
  assert.ok(names.includes('deadpool-api-v1'),
    'a new build has nothing to say about whether last Sunday board is still good');
  assert.ok(names.includes(await shellCacheName(w)), 'and the current one stays');
  assert.equal(w.state.claimed, true);
});

test('the worker waits to be told, rather than swapping mid-decision', async () => {
  const { fetchImpl } = server();
  const w = await loadWorker(fetchImpl);
  await w.install();
  assert.equal(w.state.skipWaitingCalled, false, 'installing must not activate on its own');

  w.message({ type: 'something-else' });
  assert.equal(w.state.skipWaitingCalled, false);

  w.message({ type: 'SKIP_WAITING' });
  assert.equal(w.state.skipWaitingCalled, true, 'the page decides when');
});

/* ------------------------------------------------------- what it ignores -- */

test('a POST and a cross-origin GET are left to the browser', async () => {
  const { fetchImpl } = server();
  const w = await loadWorker(fetchImpl);
  await w.install();

  assert.equal(await w.fetch(req('/api/week', { method: 'POST' })), undefined);
  assert.equal(await w.fetch({ url: 'https://fonts.example/x.woff2', method: 'GET', mode: 'no-cors' }), undefined,
    'the worker has no business answering for somebody else origin');
});
