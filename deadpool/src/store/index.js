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
import { pickId, RESULTS, usedTeams, statusOf, timeline, pickAt, boardFor, headline } from './derive.js';
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
  const ok = storage.writeJson(K_STATE, state);
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
  picks = picks.map((p) => (p.id === id ? { ...p, result, resultAt: new Date().toISOString() } : p));
  return { ok: persistPicks(), previous };
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

const cacheKey = (kind, season, week) => `${K_CACHE}${kind}.${season}${week ? `.${String(week).padStart(2, '0')}` : ''}`;

export const readCache = (kind, season, week) => storage.readJson(cacheKey(kind, season, week), null);

/**
 * Cache a payload, evicting the oldest weeks if the write does not fit.
 *
 * A failed cache write is not an alarm the way a failed pick is — the app
 * works from the network next time. So the quota alarm is cleared afterwards
 * if the only thing that failed was this.
 */
export function writeCache(kind, season, week, payload) {
  const key = cacheKey(kind, season, week);
  const body = { ...payload, cachedAt: new Date().toISOString() };
  if (storage.writeJson(key, body)) { evictCache(); return true; }

  evictCache(1);
  const second = storage.writeJson(key, body);
  if (second) storage.clearAlarm();
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

  if (mode === 'replace') {
    state = { ...defaultState(), ...(result.record ?? {}), schema: SCHEMA };
    picks = incoming.slice().sort(byWeekThenEntry);
  } else {
    const have = new Set(picks.map((p) => p.id));
    picks = [...picks, ...incoming.filter((p) => !have.has(p.id))].sort(byWeekThenEntry);
  }

  const ok = persistState() && persistPicks();
  return { ok, added: mode === 'replace' ? incoming.length : picks.length, mode };
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
