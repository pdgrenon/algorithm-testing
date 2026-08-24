/**
 * The service worker.
 *
 * Bumped by scripts/stamp-sw.mjs on every change to a precached file. The
 * cache is an ATOMIC SNAPSHOT: a new worker precaches a whole new set under a
 * new name and then waits, the page offers a reload, and activate() swaps
 * everything at once. That is what makes cache-first below safe — there is no
 * arrangement of events that leaves half the old app running against half the
 * new one.
 */

// deadpool-precache-version — do not edit by hand; run `npm run stamp`.
const CACHE = 'deadpool-v1-118c644';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/assets/apple-touch-icon.png',
  '/assets/favicon.svg',
  '/assets/fonts/archivo-latin.woff2',
  '/assets/fonts/fonts.css',
  '/assets/fonts/jetbrains-mono-latin.woff2',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon-maskable-512.png',
  '/src/app.js',
  '/src/css/app.css',
  '/src/css/base.css',
  '/src/css/tokens.css',
  '/src/data/backoff.js',
  '/src/data/source.js',
  '/src/data/teams.js',
  '/src/engine/calendar.js',
  '/src/engine/constraints.js',
  '/src/engine/espn.js',
  '/src/engine/field.js',
  '/src/engine/fmt.js',
  '/src/engine/future-value.js',
  '/src/engine/index.js',
  '/src/engine/measured.js',
  '/src/engine/nflverse.js',
  '/src/engine/payout.js',
  '/src/engine/pool-sheet.js',
  '/src/engine/strategies/distinct.js',
  '/src/engine/strategies/entry-a-value.js',
  '/src/engine/strategies/entry-b-hedge.js',
  '/src/engine/strategies/joint-optimizer.js',
  '/src/engine/strategies/leverage.js',
  '/src/engine/strategies/recommender.js',
  '/src/engine/strategies/sequence-dp.js',
  '/src/engine/win-prob.js',
  '/src/store/derive.js',
  '/src/store/index.js',
  '/src/store/migrations.js',
  '/src/store/storage.js',
  '/src/ui/dom.js',
  '/src/ui/fx.js',
  '/src/ui/icons.js',
  '/src/views/board.js',
  '/src/views/pool.js',
  '/src/views/season.js',
  '/src/views/settings.js',
  '/src/views/week.js',
];

/**
 * The API cache is separate and survives an app update.
 *
 * A new version of the code has nothing to say about whether last Sunday's
 * board is still good, and throwing it away on every deploy would mean an
 * update lands somebody offline with no games.
 */
const API_CACHE = 'deadpool-api-v1';

const NAV_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache:'reload' bypasses the HTTP cache, so a version bump can never bake
    // in a stale copy the browser happened to be holding.
    await Promise.all(APP_SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
  })());
});

/**
 * No automatic skipWaiting.
 *
 * The page decides when to swap. An update that took effect on its own would
 * do so at whatever moment it finished downloading, which on a Sunday is
 * roughly the moment somebody is deciding a pick.
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/**
 * A captive portal answers 200 with its own login page.
 *
 * Only a same-origin HTML response may replace the cached shell, or the app
 * gets overwritten by an airport wifi terms-of-service page and stays that way
 * until somebody clears site data.
 */
function isOwnHtml(res, url) {
  if (!res || !res.ok || res.redirected) return false;
  if (res.type === 'opaque' || res.type === 'opaqueredirect') return false;
  if (new URL(url).origin !== self.location.origin) return false;
  return (res.headers.get('content-type') || '').includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The schedule: network first, because a fresher board is the point, with
  // the last good answer behind it. src/data/source.js layers its own
  // localStorage copy under this, so there are two independent fallbacks.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(API_CACHE);
          await cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        const hit = await caches.match(req);
        return hit ?? new Response(JSON.stringify({ ok: false, error: 'offline', source: 'offline' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
    })());
    return;
  }

  // Navigations race the network against a short timer, so half-connected
  // stadium wifi falls back to the cached shell instead of hanging on white.
  //
  // A fresh shell is served but deliberately NOT written back into CACHE.
  // Writing it there is what broke the atomic snapshot above: after a deploy
  // the running worker is still the old one, so the put dropped the new
  // index.html into the old version's cache beside the old modules, and every
  // load after it -- offline ones included -- served a shell from one version
  // against a `/src/` tree from another. Nothing is lost by leaving it out.
  // Any change to index.html restamps CACHE, so a new shell always arrives
  // with the snapshot that matches it, and install() is all-or-nothing, so
  // there is no half-precached state for a write-back to repair.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('/index.html', { ignoreSearch: true });
      try {
        const fresh = await Promise.race([
          fetch(req),
          new Promise((_, reject) => setTimeout(() => reject(new Error('nav timeout')), NAV_TIMEOUT_MS)),
        ]);
        if (isOwnHtml(fresh, req.url)) return fresh;
        return cached || fresh;
      } catch {
        return cached || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // Never cache an opaque response: its status is unreadable, so an error
      // page is indistinguishable from the real asset and would poison the
      // cache permanently.
      if (res && res.ok && res.type !== 'opaque') {
        const cache = await caches.open(CACHE);
        await cache.put(req, res.clone());
      }
      return res;
    } catch {
      return Response.error();
    }
  })());
});
