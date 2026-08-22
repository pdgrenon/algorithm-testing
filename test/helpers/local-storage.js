/**
 * A localStorage that behaves like the real one, including the ways it fails.
 *
 * The interesting parts are the failures. A store that always succeeds cannot
 * test the quota alarm or the corruption quarantine, and those two paths are
 * the ones that decide whether somebody loses a season.
 */
export function installLocalStorage({ quota = Infinity, blocked = false } = {}) {
  const mem = new Map();
  let bytes = 0;

  const store = {
    get length() { return mem.size; },
    key(i) { return [...mem.keys()][i] ?? null; },
    getItem(k) { return mem.has(k) ? mem.get(k) : null; },
    setItem(k, v) {
      if (blocked) { const e = new Error('The operation is insecure.'); e.name = 'SecurityError'; throw e; }
      const s = String(v);
      const next = bytes - (mem.get(k)?.length ?? 0) + s.length;
      if (next > quota) {
        const e = new Error('exceeded the quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      bytes = next;
      mem.set(k, s);
    },
    removeItem(k) { bytes -= mem.get(k)?.length ?? 0; mem.delete(k); },
    clear() { mem.clear(); bytes = 0; },
    /** Test-only: write bytes that are not JSON. */
    _poison(k, raw) { mem.set(k, raw); },
    _raw: mem,
  };

  globalThis.localStorage = store;
  return store;
}

/** Import the store fresh, so module-level state does not leak between tests. */
export async function freshStore() {
  const url = new URL('../../deadpool/src/store/index.js', import.meta.url);
  return import(`${url.href}?t=${Math.random()}`);
}
