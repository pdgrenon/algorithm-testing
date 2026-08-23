/**
 * Enough of a service worker's globals to run deadpool/sw.js and ask it things.
 *
 * The worker decides what the app is offline, which is most of what a PWA is,
 * and none of it was reachable from a test before this. What it needs is
 * small: a CacheStorage, a fetch it does not control, and the three events.
 *
 * The requests handed *to* the worker are plain objects rather than `Request`.
 * It reads `url`, `method` and `mode`, and passes the object to `fetch` and
 * `cache.put` — both of which are ours here — so nothing is gained by making
 * undici adjudicate a `mode: 'navigate'` the Request constructor is not
 * allowed to set. `Request` itself is still shimmed below, because the install
 * handler constructs its own from scope-relative paths.
 */

const ORIGIN = 'https://deadpool.example';

const urlOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).toString() : req.url);
const stripSearch = (u) => { const x = new URL(u); x.search = ''; return x.toString(); };

class FakeCache {
  constructor(name) { this.name = name; this.entries = new Map(); }

  async put(request, response) { this.entries.set(urlOf(request), response); }

  async match(request, { ignoreSearch = false } = {}) {
    const want = urlOf(request);
    const hit = this.entries.get(want);
    if (hit) return hit;
    if (!ignoreSearch) return undefined;
    const bare = stripSearch(want);
    for (const [k, v] of this.entries) if (stripSearch(k) === bare) return v;
    return undefined;
  }

  async add(request) {
    const res = await globalThis.fetch(request);
    if (!res || !res.ok) throw new TypeError(`add() failed for ${urlOf(request)}`);
    await this.put(request, res);
  }

  async keys() { return [...this.entries.keys()]; }
}

class FakeCacheStorage {
  constructor() { this.stores = new Map(); }

  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache(name));
    return this.stores.get(name);
  }

  async match(request, options) {
    for (const cache of this.stores.values()) {
      const hit = await cache.match(request, options);
      if (hit) return hit;
    }
    return undefined;
  }

  async keys() { return [...this.stores.keys()]; }

  async delete(name) { return this.stores.delete(name); }
}

/**
 * Install the globals and import a fresh copy of the worker.
 *
 * `fetchImpl` is the network. It is given the request object and returns a
 * Response, or throws for a transport failure.
 */
export async function loadWorker(fetchImpl) {
  const listeners = new Map();
  const caches = new FakeCacheStorage();
  const state = { skipWaitingCalled: false, claimed: false, fetches: [] };

  globalThis.caches = caches;
  globalThis.fetch = async (req) => { state.fetches.push(urlOf(req)); return fetchImpl(req); };
  // A worker resolves a relative Request against its scope; Node's requires an
  // absolute URL. The install handler builds `new Request('/', ...)`, so
  // without this the precache cannot run at all.
  globalThis.Request = class ScopedRequest {
    constructor(input, init = {}) {
      this.url = urlOf(input);
      this.method = init.method ?? (typeof input === 'object' ? input.method : null) ?? 'GET';
      this.mode = init.mode ?? (typeof input === 'object' ? input.mode : null) ?? 'no-cors';
      this.cache = init.cache ?? null;
    }
  };
  globalThis.self = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    location: new URL(`${ORIGIN}/`),
    skipWaiting: () => { state.skipWaitingCalled = true; },
    clients: { claim: async () => { state.claimed = true; } },
  };

  const url = new URL('../../deadpool/sw.js', import.meta.url);
  await import(`${url.href}?t=${Math.random()}`);

  const lifecycle = async (type) => {
    let held;
    listeners.get(type)({ waitUntil: (p) => { held = p; } });
    await held;
  };

  return {
    caches,
    state,
    /** Run the install handler to completion, precaching the shell. */
    install: () => lifecycle('install'),
    /** Run the activate handler to completion, dropping stale caches. */
    activate: () => lifecycle('activate'),
    message: (data) => listeners.get('message')({ data }),
    /**
     * Dispatch a fetch. Returns the response the worker produced, or
     * `undefined` where it declined to handle the request at all.
     */
    fetch: async (request) => {
      let held;
      listeners.get('fetch')({ request, respondWith: (p) => { held = p; } });
      return held === undefined ? undefined : held;
    },
  };
}

/** A request, in the shape the worker reads. */
export const req = (path, { method = 'GET', mode = 'no-cors' } = {}) => ({
  url: new URL(path, ORIGIN).toString(), method, mode,
});

/** A response, with the headers the worker inspects. */
export const res = (body, { status = 200, type = 'basic', redirected = false, contentType = 'text/plain' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  type,
  redirected,
  body,
  headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
  clone() { return { ...this, clone: this.clone }; },
});

export const html = (body, over = {}) => res(body, { contentType: 'text/html; charset=utf-8', ...over });
export const ORIGIN_URL = ORIGIN;
