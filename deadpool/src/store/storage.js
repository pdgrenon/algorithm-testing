/**
 * The only thing in this app that touches localStorage.
 *
 * Everything a person types or taps lives on their own device and goes
 * nowhere. The Content-Security-Policy pins connect-src to 'self', so the only
 * host reachable from the page is this app's own origin, and the only thing
 * there is a stateless proxy that reads ESPN and holds nothing. That is
 * enforced by the browser rather than by this comment.
 *
 * Three failure modes are handled here rather than anywhere else, because all
 * three are silent by default and all three lose a season:
 *
 *   1. A write that fails. Quota exhaustion and Safari's private mode both
 *      throw. A pick that did not save has to be visible immediately — the
 *      alternative is finding out next Sunday that the app forgot.
 *   2. Bytes that will not parse. There is no server, so those are the only
 *      bytes there are. They are copied aside and kept rather than repaired,
 *      because guessing at a repair is guesswork on somebody's record.
 *   3. Storage that is not there at all. A page in a locked-down browser
 *      should run and say it cannot remember, not white-screen.
 */

const CORRUPT_SUFFIX = '.corrupt';

/** Raised to the interface when a write did not land. */
let alarm = null;
const listeners = new Set();

export const onAlarm = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const currentAlarm = () => alarm;

function raise(kind, detail) {
  alarm = { kind, detail, at: new Date().toISOString() };
  for (const fn of listeners) { try { fn(alarm); } catch { /* a listener must not break a save */ } }
}

/**
 * Put the alarm back the way it was, or clear it when there was none.
 *
 * The cache path is why this takes an argument. Its own failure is not worth
 * an alarm -- the app refetches next time -- but it shares this one global
 * with the pick path, and clearing unconditionally swallowed a pick that had
 * just failed to save. Restoring what was standing keeps the more important
 * message, which is always the one about somebody's own record.
 */
export function restoreAlarm(previous = null) {
  alarm = previous;
  for (const fn of listeners) { try { fn(alarm); } catch { /* as above */ } }
}

export function clearAlarm() {
  restoreAlarm(null);
}

/**
 * Raise an alarm for a write this layer never attempted.
 *
 * Everything else here raises from a failed `setItem`. The store refuses some
 * writes before they get that far — a record a newer build wrote is not
 * written back by an older one — and a refusal nobody is told about is
 * indistinguishable from a save.
 */
export const raiseAlarm = (kind, detail) => raise(kind, detail);

/** Whether localStorage exists and can be written to at all. */
export function available() {
  try {
    const probe = '__deadpool_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function readRaw(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Parse a stored value, quarantining anything that will not.
 *
 * The corrupt copy is written once and never overwritten: a second failure
 * must not destroy the evidence from the first, which is usually the more
 * complete record.
 */
export function readJson(key, fallback = null) {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    const grave = `${key}${CORRUPT_SUFFIX}`;
    if (readRaw(grave) === null) {
      try { localStorage.setItem(grave, raw); } catch { /* nothing further to try */ }
    }
    raise('unreadable', `${key} could not be parsed. The original bytes are kept under ${grave} and can be exported.`);
    return fallback;
  }
}

/**
 * Write, and say so if it did not work.
 *
 * Returns true on success. Callers that are recording something a person just
 * did should check it — a pick that silently did not save is the worst thing
 * this app could do.
 */
export function writeJson(key, value) {
  let body;
  try {
    body = JSON.stringify(value);
  } catch (err) {
    raise('unserialisable', `${key} could not be turned into JSON: ${err.message}`);
    return false;
  }
  try {
    localStorage.setItem(key, body);
    return true;
  } catch (err) {
    const quota = err && /quota|exceed/i.test(String(err.name || err.message));
    raise(
      quota ? 'full' : 'blocked',
      quota
        ? 'This device is out of storage for the app. Clearing cached weeks in Settings will free some; export a backup first.'
        : `The browser refused to save (${err && err.name ? err.name : 'unknown'}). Private browsing and blocked site data both do this.`,
    );
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(key); return true; } catch { return false; }
}

/** Every key this app owns, for export, eviction and erase. */
export function keys(prefix) {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
  } catch { /* an inaccessible store has no keys */ }
  return out.sort();
}

/** Roughly how many bytes a set of keys is using, for the settings screen. */
export function bytesUsed(prefix) {
  let n = 0;
  for (const k of keys(prefix)) n += (readRaw(k) ?? '').length + k.length;
  return n;
}
