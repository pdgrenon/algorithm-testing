/**
 * The strategy registry, and the only way the app is allowed to run one.
 *
 * "Plug-and-play" means something checkable here: adding a strategy is one
 * file and one line in STRATEGIES below, and it arrives in the app with its
 * parameters as working controls, its output in the comparison view and its
 * picks in the backtest — with no interface written for it. That works because
 * every strategy declares its parameters as data and returns one shape.
 *
 * ── The contract ────────────────────────────────────────────────────────
 *
 *   id       stable, and written onto every pick that came from it, so a
 *            season can be reviewed by which strategy made the call
 *   name     what a person reads
 *   blurb    one sentence, in the settings list
 *   entries  'single' — reasons about one entry at a time, run per entry
 *            'both'   — reasons about the pair, run once
 *   params   [{ key, label, type, default, min, max, step, unit, help }]
 *   run(ctx) pure. no fetch, no Date.now(), no Math.random().
 *
 * The purity rule is not style. It is what lets a whole season be replayed
 * from cached weeks, what makes the golden parity fixtures possible at all,
 * and what stops the app and the calendar disagreeing about the same Sunday.
 * A strategy that read a clock could not be backtested and would produce a
 * different answer on Saturday than it did on Sunday for reasons no one could
 * see. test/engine.test.js runs every registered strategy twice over one
 * frozen context and asserts the two results are identical.
 */

import ranked from './strategies/recommender.js';
import value from './strategies/entry-a-value.js';
import sequential from './strategies/entry-b-hedge.js';
import joint from './strategies/joint-optimizer.js';
import distinct from './strategies/distinct.js';
import sequence from './strategies/sequence-dp.js';
import { buildWinProbabilityTable } from './win-prob.js';
import { unavailableOptions } from './constraints.js';

export const DEFAULT_STRATEGY_ID = 'joint';

/**
 * The registry, as one map.
 *
 * It was an array plus a Map built from it, and those two could drift: pushing
 * a strategy onto the array left it invisible to every lookup, which is a bug
 * that would present as "my new strategy is in the settings list and does
 * nothing". One container, and the ordered list is derived from it.
 */
const REGISTRY = new Map();

/**
 * Add a strategy. This is the whole of registration.
 *
 * Validated at the point of registration rather than at first use, so a
 * malformed plug-in fails when the module loads — in the test suite, on a
 * Tuesday — instead of at 12:55 on a Sunday.
 */
export function register(strategy) {
  const problems = validateStrategy(strategy);
  if (problems.length) throw new Error(`Cannot register strategy: ${problems.join('; ')}`);
  REGISTRY.set(strategy.id, strategy);
  return strategy;
}

/** Only for tests, and named so that is obvious at the call site. */
export const unregisterForTest = (id) => REGISTRY.delete(id);

export const listStrategies = () => [...REGISTRY.values()];
export const getStrategy = (id) => REGISTRY.get(id) ?? null;

/**
 * Refuse a malformed strategy at load rather than at 12:55 on a Sunday.
 *
 * Checked by test/engine.test.js, so a new file that forgets a field fails the
 * suite instead of rendering a control with no label.
 */
export function validateStrategy(s) {
  const problems = [];
  const at = s?.id ? `strategy '${s.id}'` : 'a strategy with no id';

  if (!s?.id) problems.push('a strategy has no id');
  if (typeof s?.name !== 'string' || !s.name) problems.push(`${at} has no name`);
  if (typeof s?.blurb !== 'string' || !s.blurb) problems.push(`${at} has no blurb`);
  if (!['single', 'both'].includes(s?.entries)) problems.push(`${at} must declare entries: 'single' or 'both'`);
  if (typeof s?.run !== 'function') problems.push(`${at} has no run()`);

  for (const p of s?.params ?? []) {
    const pat = `${at} param '${p?.key ?? '?'}'`;
    if (!p?.key) problems.push(`${at} has a param with no key`);
    if (!p?.label) problems.push(`${pat} has no label`);
    if (!['int', 'float', 'percent', 'bool', 'choice'].includes(p?.type)) problems.push(`${pat} has an unknown type '${p?.type}'`);
    if (p?.default === undefined) problems.push(`${pat} has no default`);
    if (p?.type === 'choice' && !Array.isArray(p?.options)) problems.push(`${pat} is a choice with no options`);
    problems.push(...defaultProblems(pat, p));
  }
  return problems;
}

/**
 * Whether a declared default satisfies its own declaration.
 *
 * Checked here because `resolveParams` cannot: a stored value is clamped into
 * range, but an absent one takes `p.default` and returns it untouched. So a
 * default outside its own min/max is the one value that reaches a strategy
 * unchecked -- and it is the value every user gets until they move the slider.
 */
function defaultProblems(pat, p) {
  const out = [];
  const d = p?.default;
  if (d === undefined) return out;               // already reported

  if (p?.type === 'bool') {
    if (typeof d !== 'boolean') out.push(`${pat} is a bool with a ${typeof d} default`);
    return out;
  }
  if (p?.type === 'choice') {
    if (Array.isArray(p?.options) && !p.options.some((o) => o?.value === d)) {
      out.push(`${pat} defaults to ${JSON.stringify(d)}, which is not one of its options`);
    }
    return out;
  }
  if (typeof d !== 'number' || !Number.isFinite(d)) {
    out.push(`${pat} is numeric with a default of ${JSON.stringify(d)}`);
    return out;
  }
  if (p?.type === 'int' && !Number.isInteger(d)) out.push(`${pat} is an int defaulting to ${d}`);
  if (p?.min !== undefined && d < p.min) out.push(`${pat} defaults to ${d}, below its own min of ${p.min}`);
  if (p?.max !== undefined && d > p.max) out.push(`${pat} defaults to ${d}, above its own max of ${p.max}`);
  return out;
}

export function validateStrategies(strategies = listStrategies()) {
  return strategies.flatMap(validateStrategy);
}

/** Every declared default for one strategy, as a plain object. */
export const defaultParams = (strategy) =>
  Object.fromEntries((strategy?.params ?? []).map((p) => [p.key, p.default]));

/**
 * Clamp a stored parameter set back into what the strategy declares.
 *
 * Settings outlive strategies: a saved value can name a parameter that no
 * longer exists, or sit outside a range that has since narrowed. Silently
 * repairing it is right — the alternative is a strategy that throws on a
 * Sunday because of a number somebody typed in August.
 */
export function resolveParams(strategy, stored = {}) {
  const out = {};
  for (const p of strategy?.params ?? []) {
    let v = stored[p.key];
    if (v === undefined || v === null) { out[p.key] = p.default; continue; }
    if (p.type === 'bool') { out[p.key] = Boolean(v); continue; }
    if (p.type === 'choice') { out[p.key] = p.options.some((o) => o.value === v) ? v : p.default; continue; }
    v = Number(v);
    if (!Number.isFinite(v)) { out[p.key] = p.default; continue; }
    if (p.type === 'int') v = Math.round(v);
    if (p.min !== undefined) v = Math.max(p.min, v);
    if (p.max !== undefined) v = Math.min(p.max, v);
    out[p.key] = v;
  }
  return out;
}

/**
 * Assemble the frozen input a strategy reasons about.
 *
 * `schedule` is the season-wide win-probability table, and it is the reason
 * the lookahead in `value` is live here and was inert in the terminal tool:
 * pass one week of games and it contains one week, pass the season and it
 * contains the season. `scheduleWeeks` is carried so a strategy can say so
 * rather than quietly behaving like a simpler one.
 */
export function makeContext({
  season, week, seasonType = 2,
  games = [],
  scheduleGames = null,
  entries = [{ id: 'A', name: 'Entry A' }, { id: 'B', name: 'Entry B' }],
  usedTeams = {},
  params = {},
  fetchedAt = null,
  source = 'unknown',
}) {
  const all = scheduleGames ?? games;
  const weeks = new Set(all.map((g) => g.week).filter((w) => w !== null && w !== undefined));

  const ctx = {
    season, week, seasonType,
    games,
    schedule: buildWinProbabilityTable(all),
    scheduleWeeks: weeks.size,
    unavailable: unavailableOptions(games),
    entries: Object.freeze(entries.map((e) => Object.freeze({ ...e }))),
    usedTeams: Object.freeze(Object.fromEntries(entries.map((e) => [e.id, Object.freeze((usedTeams[e.id] ?? []).slice())]))),
    params,
    // Provenance, carried so the interface can say what it is working from.
    // Never read by a strategy: a decision that depended on when the data was
    // fetched would not be replayable.
    fetchedAt,
    source,
  };
  Object.freeze(ctx.games);
  return Object.freeze(ctx);
}

/**
 * Run one strategy, with its parameters resolved and its output normalised.
 *
 * A strategy that throws is contained rather than allowed to blank the screen:
 * the week still renders, with the failure stated. A strategy is a plug-in and
 * a plug-in is allowed to be broken.
 */
export function run(strategyId, ctx, storedParams = {}) {
  const strategy = getStrategy(strategyId);
  if (!strategy) {
    return { strategyId, ok: false, picks: [], candidates: {}, considered: 0, warnings: [{ level: 'danger', text: `No strategy called '${strategyId}' is registered.` }] };
  }

  const scoped = Object.freeze({ ...ctx, params: Object.freeze(resolveParams(strategy, storedParams)) });

  try {
    const result = strategy.run(scoped);
    return {
      ok: true,
      strategyId: strategy.id,
      strategyName: strategy.name,
      picks: result.picks ?? [],
      candidates: result.candidates ?? {},
      considered: result.considered ?? 0,
      warnings: result.warnings ?? [],
      shared: result.shared ?? null,
      params: scoped.params,
    };
  } catch (err) {
    return {
      ok: false,
      strategyId: strategy.id,
      strategyName: strategy.name,
      picks: [], candidates: {}, considered: 0,
      warnings: [{ level: 'danger', text: `${strategy.name} failed: ${err && err.message ? err.message : String(err)}` }],
      params: scoped.params,
    };
  }
}

/**
 * Every registered strategy over one context.
 *
 * The repository this lives in is called algorithm-testing; this is the
 * feature it is named after. Where they agree is a much stronger signal than
 * any one of them alone, and where they diverge is the interesting part of a
 * week.
 */
export function compareAll(ctx, storedParamsById = {}) {
  return listStrategies().map((s) => run(s.id, ctx, storedParamsById[s.id] ?? {}));
}

/** Which teams each entry would be put on, by strategy id. */
export function agreementOf(results) {
  const byEntry = {};
  for (const r of results) {
    for (const p of r.picks) {
      (byEntry[p.entry] ??= []).push({ strategyId: r.strategyId, team: p.candidate?.teamAbbreviation ?? null });
    }
  }
  return Object.fromEntries(Object.entries(byEntry).map(([entry, rows]) => {
    const teams = rows.map((r) => r.team).filter(Boolean);
    return [entry, { rows, unanimous: teams.length > 0 && new Set(teams).size === 1, distinct: new Set(teams).size }];
  }));
}

/**
 * The ported strategies, registered.
 *
 * Adding another is a file in ./strategies/ and a line here. Everything else —
 * the picker in Settings, its parameter controls, the comparison table, the
 * backtest — reads the registry and needs no change at all.
 */
[ranked, value, sequential, joint, distinct, sequence].forEach(register);

export { buildWinProbabilityTable };
