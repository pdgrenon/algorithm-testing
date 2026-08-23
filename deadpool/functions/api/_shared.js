/**
 * Shared helpers for the edge Functions.
 *
 * The underscore matters: Cloudflare Pages does not route a file whose name
 * starts with one, so this is a module rather than an endpoint.
 */

export const SITE_API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
export const CORE_API = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';

// Identifies the caller honestly. ESPN does not publish or support these
// endpoints, and a request that says what it is is the least this can do.
export const USER_AGENT = 'deadpool/0.1 (personal NFL survivor pool tool; one origin, cached at the edge)';

export const FETCH_TIMEOUT_MS = 8000;

/**
 * How many upstream requests may be in flight at once.
 *
 * The Python throttles to one request every half second, which is right for a
 * tool that runs on N laptops. This is one origin with a shared cache in front
 * of it, so the correct trade is different: a small burst that finishes fast
 * and then does not come back for hours beats a slow drip repeated per device.
 * Six is enough to make a week land in about two round trips.
 */
export const CONCURRENCY = 6;

/** Run `fn` over `items`, at most `n` at a time, preserving order. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next; next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Fetch JSON, or null.
 *
 * Never throws. A missing sub-resource degrades one game rather than failing
 * the week, which is the same posture as the Python client's `_safe_get` — the
 * difference being that here a whole endpoint can be the thing that is
 * missing.
 */
export async function fetchJson(url) {
  return (await fetchUpstream(url)).body;
}

/**
 * The same fetch, with the reason it failed.
 *
 * `fetchJson` collapses four different failures into `null` -- a refusal, a
 * timeout, malformed JSON, and a transport error are indistinguishable to its
 * caller, which then reports "ESPN did not answer" for all of them. That is
 * the right message for a *user* and the wrong one for anybody trying to fix
 * a deployment: it cost six round trips of guessing to establish that a live
 * one was being refused rather than timing out.
 *
 * Returns `{ body, status, reason }`. `body` is null unless the fetch
 * succeeded and parsed. `reason` is one of:
 *
 *   'refused'   an HTTP status the upstream chose -- carried in `status`
 *   'timeout'   no answer inside FETCH_TIMEOUT_MS
 *   'malformed' answered, but the body was not JSON
 *   'transport' DNS, TLS, or the request never left
 *
 * Nothing sensitive travels in any of them: the upstream is a public
 * endpoint and the status is its own.
 */
export async function fetchUpstream(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!res.ok) return { body: null, status: res.status, reason: 'refused' };
    try {
      return { body: await res.json(), status: res.status, reason: null };
    } catch {
      return { body: null, status: res.status, reason: 'malformed' };
    }
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || String(err).includes('abort'));
    return { body: null, status: null, reason: aborted ? 'timeout' : 'transport' };
  } finally {
    clearTimeout(timer);
  }
}


/**
 * How long this payload stays fresh, in seconds.
 *
 * Tiered by how close the first kickoff is, replacing the Python's flat four
 * hours. Four hours is fine on a Tuesday and completely wrong at 12:45 on a
 * Sunday, which is the one moment the number actually decides something.
 */
export function ttlFor(games, now = Date.now()) {
  const kickoffs = games
    .map((g) => (g.startDate ? Date.parse(g.startDate) : NaN))
    .filter((t) => Number.isFinite(t));
  if (!kickoffs.length) return 3600;

  const first = Math.min(...kickoffs);
  const last = Math.max(...kickoffs);

  if (games.some((g) => g.state === 'in')) return 60;        // live: the board is moving
  if (now > last + 4 * 3600e3) return 86400;                 // week over: it will not change again
  const untilFirst = first - now;
  if (untilFirst < 3 * 3600e3) return 900;                   // inside three hours of kickoff
  if (untilFirst < 24 * 3600e3) return 3600;                 // game day approaching
  return 6 * 3600;                                           // early in the week
}

export function json(body, { status = 200, ttl = 300, stale = false } = {}) {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // A short stale-while-revalidate on top of the TTL, so a phone opened at
      // 12:50 gets an answer immediately and the refresh lands behind it.
      'Cache-Control': stale
        ? 'public, max-age=60'
        : `public, max-age=${ttl}, stale-while-revalidate=${Math.max(60, Math.floor(ttl / 2))}`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export const bad = (message, status = 400) =>
  json({ ok: false, error: message }, { status, ttl: 0, stale: true });

/**
 * Read and validate the query.
 *
 * Strict on purpose. Every value that reaches an upstream URL is a number in a
 * known range — there is no path here that takes a caller-supplied URL, host
 * or arbitrary string, so this cannot be turned into an open relay however it
 * is called.
 */
export function readParams(url, { requireWeek = false } = {}) {
  const q = new URL(url).searchParams;

  const int = (name, { min, max, fallback = null }) => {
    const raw = q.get(name);
    if (raw === null || raw === '') return fallback;
    if (!/^\d{1,4}$/.test(raw)) return { error: `${name} must be a whole number` };
    const n = Number(raw);
    if (n < min || n > max) return { error: `${name} must be between ${min} and ${max}` };
    return n;
  };

  const season = int('season', { min: 2000, max: 2099 });
  const week = int('week', { min: 1, max: 22 });
  const seasonType = int('seasontype', { min: 1, max: 4, fallback: 2 });

  for (const v of [season, week, seasonType]) if (v && v.error) return v;
  if (requireWeek && week === null) return { error: 'week is required' };

  return { season, week, seasonType };
}

/** Cloudflare's shared edge cache, when there is one. */
export async function cached(request, produce) {
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  if (!cache) return produce();

  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  const fresh = await produce();
  // Only a good answer is worth keeping. Caching a failure would turn one bad
  // minute at ESPN into hours of the app insisting there are no games.
  if (fresh.status === 200) {
    const clone = fresh.clone();
    // waitUntil is not available here, and awaiting the put is cheap next to
    // the upstream fetches it saves.
    await cache.put(key, clone);
  }
  return fresh;
}
