/**
 * The store: settings, the pick log, and the week cache.
 *
 * Two keyspaces, and keeping them apart is load-bearing rather than tidy.
 * `deadpool.state.v1` and `deadpool.picks.v1` are a person's own record and
 * are never evicted. `deadpool.cache.v1.*` holds ESPN snapshots, is evicted
 * oldest-first, and can be thrown away entirely without losing anything.
 * localStorage is about 5MB in total and one week of games is ~35KB, so a full
 * season of cached weeks plus a season schedule will run into that ceiling —
 * at which point the cache must be what gives way, never the picks.
 */

import * as storage from './storage.js';
import { SCHEMA, migrate } from './migrations.js';
import { pickId, RESULTS, usedTeams, statusOf, timeline, pickAt, boardFor, headline, settleable } from './derive.js';
import { DEFAULT_STRATEGY_ID } from '../engine/index.js';

const K_STATE = 'deadpool.state.v1';
const K_PICKS = 'deadpool.picks.v1';
const K_CACHE = 'deadpool.cache.v1.';
const PREFIX = 'deadpool.';

/** How many cached weeks to keep. Beyond this the oldest are dropped. */
const CACHE_KEEP = 8;

export const CURRENT_SEASON = 2026;

function defaultState() {
  return {
    schema: SCHEMA,
    entries: [
      { id: 'A', name: 'Entry A' },
      { id: 'B', name: 'Entry B' },
    ],
    season: CURRENT_SEASON,
    // Pool rules. Defaults are the classic ones; both are here because both
    // vary between pools and guessing either would silently misreport whether
    // somebody is still in.
    strikesAllowed: 1,
    // The field. 250 entries at $10 is a $2,500 pot, so a fair entry is worth
    // exactly the buy-in. This is not decoration: pool size decides how far
    // you have to get, which decides how much future value is worth.
    poolSize: 250,
    buyIn: 10,
    // What happens when nobody survives all 18 weeks -- the modal outcome at
    // this field size, not an edge case. See models/payout.py.
    terminalRule: 'deepest-split',
    // Confirmed for this pool, and the opposite of the near-universal
    // assumption in survivor writing. It is load-bearing: it decides whether
    // P(advance) is P(win) or 1 - P(opponent wins) everywhere in the engine.
    tieIsLoss: false,
    // How many calendars this device has exported. Only ever read as an
    // iCalendar SEQUENCE, where the property that matters is that each export
    // is strictly newer than the last one — see toIcs.
    calendarRevision: 0,
    strategyId: DEFAULT_STRATEGY_ID,
    // Per-strategy, so switching back and forth does not lose what you tuned.
    params: {},
    theme: 'system',
    createdAt: new Date().toISOString(),
  };
}

let state = null;
let picks = null;
const subscribers = new Set();

export const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
function emit() { for (const fn of subscribers) { try { fn(); } catch { /* a view must not break a save */ } } }

/* ----------------------------------------------------------------- load -- */

export function load() {
  const raw = storage.readJson(K_STATE, null);
  const result = migrate(raw);

  if (!result.ok) {
    // Run on defaults and say so. The stored bytes are untouched — see
    // migrations.js for why refusing beats a downgrade.
    state = { ...defaultState(), blocked: result.reason };
  } else {
    state = result.record ? { ...defaultState(), ...result.record, schema: SCHEMA } : defaultState();
  }

  const storedPicks = storage.readJson(K_PICKS, []);
  picks = Array.isArray(storedPicks) ? storedPicks.filter(isPick) : [];
  return state;
}

/**
 * The keys that carry a person's own record, as opposed to a cached board.
 *
 * A `storage` event on one of these means another tab changed something this
 * one is holding a stale copy of; a cache write means nothing here, and
 * re-rendering for it would be noise on every refresh in every other tab.
 */
export const OWNED_KEYS = [K_STATE, K_PICKS];

/**
 * Re-read from disk, discarding what is in memory.
 *
 * `load()` is the boot path and deliberately silent. This is the same read
 * with a notification on the end, for when the bytes changed underneath a tab
 * that was already running — see the `storage` listener in app.js.
 */
export function reload() {
  load();
  emit();
  return state;
}

const isPick = (p) => p && typeof p === 'object'
  && typeof p.entry === 'string' && Number.isInteger(p.season) && Number.isInteger(p.week)
  && typeof p.team === 'string' && RESULTS.includes(p.result);

const ensure = () => { if (state === null) load(); };

export function getState() { ensure(); return state; }
export function getPicks() { ensure(); return picks.slice(); }
export const getEntries = () => getState().entries;
export const getSeason = () => getState().season;
export const poolRules = () => {
  const s = getState();
  return {
    strikesAllowed: s.strikesAllowed,
    tieIsLoss: s.tieIsLoss,
    poolSize: s.poolSize,
    buyIn: s.buyIn,
    terminalRule: s.terminalRule,
  };
};

/* ---------------------------------------------------------------- write -- */

function persistState() {
  // A record this build refused to read is never written back over.
  //
  // `migrate` already does its half: it returns `record: null` so there is
  // nothing to save. But `load()` then built a perfectly writable default with
  // `blocked` set on it, and `setSettings` merged into that and persisted the
  // whole object — `blocked` included, `schema` stamped to this build's — so
  // the newer record was gone. The banner warning about it renders on the
  // Settings screen, which made the one screen that shows the warning the one
  // screen where a single tap destroys what it warns about.
  //
  // Refusing here rather than in every caller: there is one writer, and a
  // guard on it cannot be forgotten by the next thing that writes.
  if (state?.blocked) {
    storage.raiseAlarm('blocked', 'This device holds settings from a newer version of the app, so nothing was saved. Update the app, or export a backup and erase.');
    return false;
  }
  // `blocked` is a fact about this run, not part of the record.
  const { blocked, ...body } = state ?? {};
  const ok = storage.writeJson(K_STATE, body);
  if (ok) emit();
  return ok;
}

function persistPicks() {
  const ok = storage.writeJson(K_PICKS, picks);
  if (ok) emit();
  return ok;
}

export function setSettings(patch) {
  ensure();
  state = { ...state, ...patch, schema: SCHEMA };
  return persistState();
}

/**
 * The sequence number for a calendar about to be written, having claimed it.
 *
 * Monotonic per device and persisted, because that is the only thing an
 * iCalendar SEQUENCE has to be: an export must out-rank whatever this device
 * exported before it, including a retraction it is now undoing. A pure
 * function of the current picks cannot do that — picking and clearing is a
 * cycle, and the sequence has to keep climbing through it.
 */
export function nextCalendarRevision() {
  ensure();
  const next = (Number.isInteger(state.calendarRevision) ? state.calendarRevision : 0) + 1;
  state = { ...state, calendarRevision: next, schema: SCHEMA };
  persistState();
  // Returned even if the write failed: a calendar with a sequence that does
  // not survive a reload still beats one that collides with the last export.
  return next;
}

export function setStrategy(strategyId, params) {
  ensure();
  state = {
    ...state,
    strategyId,
    params: params ? { ...state.params, [strategyId]: params } : state.params,
    schema: SCHEMA,
  };
  return persistState();
}

export const paramsFor = (strategyId) => getState().params[strategyId] ?? {};

/**
 * Record a pick, replacing whatever was in that slot.
 *
 * The id is the slot — season, week, entry — so one entry can only ever hold
 * one pick per week, structurally rather than by a check somebody might forget.
 * Changing your mind before kickoff overwrites; it does not accumulate.
 *
 * `snapshot` is what you were shown at the moment you picked, and it is the
 * field that makes a season reviewable. Sunday's odds cannot be reconstructed
 * afterwards, so without it there is no way to ask later whether the model was
 * right or you were lucky.
 */
export function recordPick({ entry, season, week, team, opponent, eventId, startDate, strategyId, snapshot, source = 'app' }) {
  ensure();
  const id = pickId(season, week, entry);
  const previous = picks.find((p) => p.id === id) ?? null;

  const pick = {
    id, entry, season, week, team,
    opponent: opponent ?? null,
    eventId: eventId ?? null,
    startDate: startDate ?? null,
    result: previous && previous.team === team ? previous.result : 'pending',
    pickedAt: new Date().toISOString(),
    strategyId: strategyId ?? null,
    source,
    snapshot: snapshot ?? null,
  };

  picks = [...picks.filter((p) => p.id !== id), pick].sort(byWeekThenEntry);
  const ok = persistPicks();
  return { ok, pick, previous };
}

export function setResult(id, result) {
  ensure();
  if (!RESULTS.includes(result)) return { ok: false };
  const previous = picks.find((p) => p.id === id) ?? null;
  if (!previous) return { ok: false };
  // Stamped 'manual' so it is distinguishable from one the app settled, and
  // so `settleResults` can never reach it again — it only ever looks at
  // pending picks, and this is now the person's answer rather than ESPN's.
  picks = picks.map((p) => (p.id === id ? { ...p, result, resultAt: new Date().toISOString(), resultSource: 'manual' } : p));
  return { ok: persistPicks(), previous };
}

/**
 * Settle every pending pick a payload can decide, and say which changed.
 *
 * The Season screen has always been one tap per result, while the app was
 * already holding the score that answers it: /api/week carries `winner` and
 * `state`, and pick_history.py has resolved picks against exactly those since
 * before the app existed. So the tap was the only thing standing between a
 * finished game and a settled log — and an unsettled log is an app that cannot
 * tell you whether you are still in the pool, which is the one question it is
 * for.
 *
 * Marked `resultSource: 'auto'` so the two are told apart afterwards. A person
 * correcting one is still authoritative: `settleable` only ever considers a
 * pending pick, so nothing typed here is reachable by this path.
 *
 * One write for the batch rather than one per pick. A Sunday evening settles a
 * dozen at once, and a dozen serialisations of the whole log on a device with
 * a full localStorage is a dozen chances to half-succeed.
 */
export function settleResults(games) {
  ensure();
  const changes = settleable(picks, games);
  if (!changes.length) return { ok: true, changed: [] };

  const at = new Date().toISOString();
  const by = new Map(changes.map((c) => [c.id, c.result]));
  const before = picks.filter((p) => by.has(p.id));

  picks = picks.map((p) => (by.has(p.id)
    ? { ...p, result: by.get(p.id), resultAt: at, resultSource: 'auto' }
    : p));

  const ok = persistPicks();
  // A failed write must not be reported as settled: the alarm has been raised
  // by storage, and the caller's toast would otherwise claim a change that is
  // not on disk and will be gone at the next reload.
  if (!ok) { picks = picks.map((p) => before.find((b) => b.id === p.id) ?? p); return { ok: false, changed: [] }; }
  return { ok, changed: changes, previous: before };
}

export function removePick(id) {
  ensure();
  const previous = picks.find((p) => p.id === id) ?? null;
  if (!previous) return { ok: false };
  picks = picks.filter((p) => p.id !== id);
  return { ok: persistPicks(), previous };
}

/** Put a removed or overwritten pick back exactly as it was — the undo path. */
export function restorePick(pick) {
  ensure();
  picks = [...picks.filter((p) => p.id !== pick.id), pick].sort(byWeekThenEntry);
  return persistPicks();
}

const byWeekThenEntry = (a, b) => a.season - b.season || a.week - b.week || (a.entry < b.entry ? -1 : 1);

/* ---------------------------------------------------------- derivations -- */

export const usedTeamsFor = (entry, season = getSeason()) => usedTeams(getPicks(), entry, season);

export function usedTeamsByEntry(season = getSeason()) {
  return Object.fromEntries(getEntries().map((e) => [e.id, usedTeams(getPicks(), e.id, season)]));
}

export const statusFor = (entry, season = getSeason()) => statusOf(getPicks(), entry, season, poolRules());
export const timelineFor = (season = getSeason()) => timeline(getPicks(), season, getEntries());
export const pickAtWeek = (entry, week, season = getSeason()) => pickAt(getPicks(), entry, season, week);
export const boardOf = (entry, weekGames, allAbbrs, season = getSeason()) => boardFor(getPicks(), entry, season, weekGames, allAbbrs);
export const headlineOf = (week, season = getSeason()) => headline(getPicks(), season, getEntries(), week, poolRules());

/* --------------------------------------------------------------- cache -- */

/**
 * `current` — the pointer to the last season and week the app saw — is
 * deliberately NOT keyed by season, where every other cached payload is.
 *
 * It used to be. That made it the one key read under one season and written
 * under another: `loadWeek` read it at `store.getSeason()` and wrote it at
 * `fresh.season`, which are the same string only for as long as those two
 * agree. Nothing ever wrote a season back to state — it is seeded from
 * `CURRENT_SEASON` and left alone — so the first rollover past that constant
 * aimed every read at a key nothing would write again.
 *
 * Online that is invisible, because the network answers anyway. Offline it is
 * the app's whole premise failing silently: a cold start finds no pointer, so
 * no week, so no cached payload, and the Week screen says "This device has no
 * cached week" over a localStorage holding several. `evictCache` sorts
 * lexically, so the previous season's last week is the first thing dropped
 * and there is no stale fallback behind it either.
 *
 * A pointer to "which season is current" cannot be filed under the answer.
 */
const cacheKey = (kind, season, week) => (kind === 'current'
  ? `${K_CACHE}current`
  : `${K_CACHE}${kind}.${season}${week ? `.${String(week).padStart(2, '0')}` : ''}`);

export const readCache = (kind, season, week) => storage.readJson(cacheKey(kind, season, week), null);

/**
 * Cache a payload, evicting the oldest weeks if the write does not fit.
 *
 * A failed cache write is not an alarm the way a failed pick is — the app
 * works from the network next time. So the quota alarm is cleared afterwards
 * if the only thing that failed was this.
 *
 * "If the only thing that failed was this" is the whole of it, and clearing
 * unconditionally was not that. A device full enough to refuse a cache write
 * is exactly a device that has just refused a pick, and on that device this
 * ran a moment later, succeeded on the retry, and took the pick's alarm down
 * with it — leaving a screen that said nothing over a pick that was never
 * saved. Whatever was already standing is put back instead, on both paths.
 */
export function writeCache(kind, season, week, payload) {
  const key = cacheKey(kind, season, week);
  const body = { ...payload, cachedAt: new Date().toISOString() };
  const standing = storage.currentAlarm();
  if (storage.writeJson(key, body)) { evictCache(); return true; }

  evictCache(1);
  const second = storage.writeJson(key, body);
  if (second || standing) storage.restoreAlarm(standing);
  return second;
}

/** Drop the oldest cached weeks beyond `keep`. Never touches state or picks. */
export function evictCache(extra = 0) {
  const weekKeys = storage.keys(`${K_CACHE}week.`).sort();
  const surplus = weekKeys.length - Math.max(0, CACHE_KEEP - extra);
  for (let i = 0; i < surplus; i += 1) storage.remove(weekKeys[i]);
  return Math.max(0, surplus);
}

export function clearCache() {
  const all = storage.keys(K_CACHE);
  for (const k of all) storage.remove(k);
  emit();
  return all.length;
}

export const cacheBytes = () => storage.bytesUsed(K_CACHE);
export const totalBytes = () => storage.bytesUsed(PREFIX);

/* ------------------------------------------------------- backup / erase -- */

/**
 * Everything worth keeping, as one object.
 *
 * The cache is excluded on purpose: it is a copy of ESPN's data, it is the
 * bulk of the bytes, and it is re-fetchable. A backup should be the part that
 * cannot be got back.
 */
export function exportAll() {
  ensure();
  return {
    app: 'deadpool',
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    state,
    picks,
  };
}

/**
 * Restore from a backup.
 *
 * 'replace' is what it says. 'merge' keeps what is already here and adds only
 * picks whose slot is empty — so importing an older backup onto a device that
 * has since moved on cannot roll a week back.
 */
export function importAll(payload, { mode = 'merge' } = {}) {
  ensure();
  if (!payload || payload.app !== 'deadpool' || !Array.isArray(payload.picks)) {
    return { ok: false, reason: 'That file is not a Deadpool backup.' };
  }
  const result = migrate(payload.state ?? null);
  if (!result.ok) return { ok: false, reason: result.reason };

  const incoming = payload.picks.filter(isPick);

  let added;
  if (mode === 'replace') {
    state = { ...defaultState(), ...(result.record ?? {}), schema: SCHEMA };
    picks = incoming.slice().sort(byWeekThenEntry);
    added = incoming.length;
  } else {
    const have = new Set(picks.map((p) => p.id));
    const fresh = incoming.filter((p) => !have.has(p.id));
    picks = [...picks, ...fresh].sort(byWeekThenEntry);
    // How many arrived, not how many are now held. Merging read
    // `picks.length`, so importing a backup with nothing new in it onto a
    // season already twelve weeks deep reported twelve picks added.
    added = fresh.length;
  }

  const ok = persistState() && persistPicks();
  return { ok, added, mode };
}

export function eraseAll() {
  for (const k of storage.keys(PREFIX)) storage.remove(k);
  state = defaultState();
  picks = [];
  persistState();
  persistPicks();
  return true;
}

export { storage, pickId, RESULTS };
