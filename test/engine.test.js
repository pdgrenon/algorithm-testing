/**
 * The engine's contract, as opposed to its answers.
 *
 * test/parity.test.js proves the strategies decide what the Python decides.
 * This proves the things that make them safe to plug in: that every registered
 * strategy declares what the interface needs, that none of them can reach a
 * clock or the network, that the same context always produces the same result,
 * and that a broken one is contained rather than allowed to blank the screen.
 *
 * The purity assertion is the load-bearing one. It is what makes a season
 * replayable, what makes the golden fixtures possible at all, and what stops
 * the app and the calendar disagreeing about the same Sunday. It is checked
 * statically, by reading the files, because a strategy that only reads a clock
 * on the third Tuesday of a month would pass any number of runtime checks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  register, unregisterForTest, validateStrategies, validateStrategy, getStrategy, listStrategies,
  defaultParams, resolveParams, makeContext, run, compareAll, agreementOf,
} from '../deadpool/src/engine/index.js';

const STRATEGIES = listStrategies();
import { MEASURED, RUN } from '../deadpool/src/engine/measured.js';
import { buildOptions, unavailableOptions, isPickable, byWinPctDesc } from '../deadpool/src/engine/constraints.js';
import { parseGames, parseProbability, parseOdds } from '../deadpool/src/engine/espn.js';
import {
  DEVIG_METHODS, TIE_PROBABILITY, advanceProbability, basisPhrase, devig,
  estimateWinPctFromSpread, impliedProbFromMoneyline, resolveTeamWinProbability,
  shrinkTowardPrior, winPctFromMoneylines,
} from '../deadpool/src/engine/win-prob.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(ROOT, 'deadpool/src/engine');

/* ---------------------------------------------------------------- setup -- */

function fixtureContext(name = 'season-2026', week = 3, over = {}) {
  const raw = JSON.parse(readFileSync(join(ROOT, `fixtures/weeks/${name}.json`), 'utf8'));
  const bundles = raw.weeks
    ? new Map(Object.entries(raw.weeks).map(([w, b]) => [Number(w), b]))
    : new Map([[raw.meta.week, raw]]);

  const gamesOf = (b) => {
    const games = parseGames(b.scoreboard);
    for (const g of games) {
      g.probability = parseProbability(b.probabilities[g.eventId] ?? null);
      g.odds = parseOdds(b.odds[g.eventId] ?? null);
    }
    return games;
  };

  return makeContext({
    season: 2026,
    week,
    games: gamesOf(bundles.get(week)),
    scheduleGames: [...bundles.keys()].sort((a, b) => a - b).flatMap((w) => gamesOf(bundles.get(w))),
    usedTeams: { A: [], B: [] },
    ...over,
  });
}

const walk = (dir, out = []) => {
  for (const n of readdirSync(dir).sort()) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (n.endsWith('.js')) out.push(f);
  }
  return out;
};

/* ------------------------------------------------------------- registry -- */

test('every registered strategy declares what the interface needs', () => {
  const problems = validateStrategies();
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(STRATEGIES.length >= 6, 'every ported strategy should be registered');
});

test('strategy ids are unique and resolvable', () => {
  const ids = STRATEGIES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(getStrategy(id).id, id);
  assert.equal(getStrategy('no-such-strategy'), null);
});

test('a strategy adds itself to the interface by existing — no UI change needed', () => {
  // The whole claim of the registry, stated as a test: a strategy carries
  // everything the settings screen needs to draw it, so a new file appears
  // there working rather than half-drawn.
  for (const s of listStrategies()) {
    assert.ok(s.name && s.blurb, `${s.id} needs a name and a blurb for the picker`);
    for (const p of s.params ?? []) {
      assert.ok(p.label, `${s.id}.${p.key} needs a label`);
      assert.ok(p.default !== undefined, `${s.id}.${p.key} needs a default`);
      if (['int', 'float', 'percent'].includes(p.type)) {
        assert.ok(Number.isFinite(p.min) && Number.isFinite(p.max), `${s.id}.${p.key} needs a range so a slider can be drawn`);
      }
    }
  }
});

/* --------------------------------------------------------------- purity -- */

test('nothing in the engine can reach a clock, a die, or the network', () => {
  const FORBIDDEN = [
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/\bnew\s+Date\s*\(\s*\)/, 'new Date() with no argument'],
    [/\bMath\.random\s*\(/, 'Math.random()'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/\blocalStorage\b/, 'localStorage'],
    [/\bdocument\b/, 'document'],
  ];
  const problems = [];
  for (const file of walk(ENGINE)) {
    // Comments discuss all of these by name; only code counts.
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const [re, what] of FORBIDDEN) {
      if (re.test(code)) problems.push(`${file.slice(ROOT.length + 1)} uses ${what}`);
    }
  }
  assert.deepEqual(problems, [], `The engine must be pure:\n${problems.join('\n')}`);
});

test('the same context produces the same result, every time', () => {
  const ctx = fixtureContext();
  for (const s of STRATEGIES) {
    const a = run(s.id, ctx);
    const b = run(s.id, ctx);
    assert.deepEqual(b, a, `${s.id} is not deterministic — a season could not be replayed from it`);
  }
});

test('a context is frozen, so a strategy cannot rewrite the board it was given', () => {
  const ctx = fixtureContext();
  assert.throws(() => { ctx.week = 99; }, TypeError);
  assert.throws(() => { ctx.games.push({}); }, TypeError);
  assert.throws(() => { ctx.usedTeams.A.push('KC'); }, TypeError);
});

/* --------------------------------------------------------------- params -- */

test('stored parameters are clamped back into what the strategy declares', () => {
  const joint = getStrategy('joint');
  assert.deepEqual(resolveParams(joint, {}), defaultParams(joint));
  assert.equal(resolveParams(joint, { minWinProbFloorB: 500 }).minWinProbFloorB, 99, 'above the range');
  assert.equal(resolveParams(joint, { minWinProbFloorB: -20 }).minWinProbFloorB, 0, 'below the range');
  assert.equal(resolveParams(joint, { minWinProbFloorB: 'nonsense' }).minWinProbFloorB, 65, 'unparseable falls back to the default');
  assert.equal(resolveParams(joint, { removedLastYear: 1 }).removedLastYear, undefined, 'a parameter that no longer exists is dropped');

  const value = getStrategy('value');
  assert.equal(resolveParams(value, { lookaheadWeeks: 6.7 }).lookaheadWeeks, 7, 'an int parameter is rounded');
});

test('run() repairs a stored parameter before a strategy ever sees it', async () => {
  // `resolveParams` is tested directly above; nothing tested that `run` calls
  // it, and replacing that call with the raw stored object passed the whole
  // suite. Settings outlive strategies -- a saved value can name a parameter
  // that no longer exists, or sit outside a range that has since narrowed --
  // and the repair is what stops a strategy throwing on a Sunday over a number
  // somebody typed in August.
  const seen = [];
  register({
    id: 'params-probe',
    name: 'Params probe',
    blurb: 'Records what it was handed.',
    entries: 'single',
    params: [{ key: 'floor', label: 'Floor', type: 'percent', default: 65, min: 0, max: 99 }],
    run(ctx) { seen.push(ctx.params); return { picks: [], candidates: {}, considered: 0, warnings: [] }; },
  });
  try {
    run('params-probe', fixtureContext(), { floor: 500, goneLastYear: 1 });
    assert.equal(seen[0].floor, 99, 'a value above the declared range is clamped, not passed through');
    assert.equal('goneLastYear' in seen[0], false, 'a parameter the strategy no longer declares is dropped');
    run('params-probe', fixtureContext(), { floor: 'nonsense' });
    assert.equal(seen[1].floor, 65, 'an unparseable value falls back to the default');
  } finally {
    unregisterForTest('params-probe');
  }
});

test('parameters actually change the answer', () => {
  // A knob that is wired to nothing is worse than no knob, because it reads as
  // a decision somebody made.
  const ctx = fixtureContext('case-thin-board', 9);
  const strict = run('joint', ctx, { minWinProbFloorB: 90 });
  const loose = run('joint', ctx, { minWinProbFloorB: 0 });
  assert.notEqual(
    strict.warnings.length === 0,
    loose.warnings.length === 0,
    'the floor should bind on a thin board and not on a permissive one',
  );
});

/* ---------------------------------------------------------- constraints -- */

test('a game that has kicked off is off the board, and is reported as such', () => {
  const ctx = fixtureContext('case-started-games', 4);
  const options = buildOptions(ctx.games);
  const unavailable = unavailableOptions(ctx.games);

  assert.ok(unavailable.length > 0, 'the fixture is meant to contain started games');
  const gone = new Set(unavailable.map((u) => u.teamAbbreviation));
  for (const o of options) {
    assert.ok(!gone.has(o.teamAbbreviation), `${o.teamAbbreviation} is playing a started game and is still an option`);
  }
  for (const u of unavailable) assert.equal(u.reason, 'started');

  // And no strategy may hand one back.
  for (const s of STRATEGIES) {
    for (const p of run(s.id, ctx).picks) {
      if (p.candidate) assert.ok(!gone.has(p.candidate.teamAbbreviation), `${s.id} picked ${p.candidate.teamAbbreviation}, whose game has started`);
    }
  }
});

test('an unknown game state is pickable — it is not the same as a started one', () => {
  assert.equal(isPickable({ state: null }), true, 'a renamed ESPN field must not delete a week');
  assert.equal(isPickable({ state: 'pre' }), true);
  assert.equal(isPickable({ state: 'in' }), false);
  assert.equal(isPickable({ state: 'post' }), false);
});

test('a team with no line sorts last rather than disappearing', () => {
  const list = [
    { teamAbbreviation: 'A', winPct: null },
    { teamAbbreviation: 'B', winPct: 55 },
    { teamAbbreviation: 'C', winPct: 80 },
  ].sort(byWinPctDesc);
  assert.deepEqual(list.map((x) => x.teamAbbreviation), ['C', 'B', 'A']);
});

test('no strategy offers a team the entry has already used', () => {
  const used = { A: ['MIN', 'SF', 'BAL', 'KC', 'BUF'], B: ['DET', 'GB', 'PHI', 'DAL', 'HOU'] };
  const ctx = fixtureContext('season-2026', 3, { usedTeams: used });
  for (const s of STRATEGIES) {
    for (const p of run(s.id, ctx).picks) {
      if (!p.candidate) continue;
      assert.ok(
        !used[p.entry].includes(p.candidate.teamAbbreviation),
        `${s.id} offered ${p.entry} a team it has already spent`,
      );
    }
  }
});

test('a pair strategy never puts both entries in one game', () => {
  for (const week of [1, 5, 9, 14]) {
    const ctx = fixtureContext('season-2026', week);
    for (const id of ['joint', 'sequential']) {
      const picks = run(id, ctx).picks.filter((p) => p.candidate);
      if (picks.length < 2) continue;
      assert.notEqual(
        picks[0].candidate.eventId, picks[1].candidate.eventId,
        `${id} put both entries in one game in week ${week} — a single result would end the season`,
      );
      assert.notEqual(picks[0].candidate.teamAbbreviation, picks[1].candidate.teamAbbreviation);
    }
  }
});

/* ------------------------------------------------------------- failures -- */

test('an unregistered strategy is refused, not thrown', () => {
  const r = run('does-not-exist', fixtureContext());
  assert.equal(r.ok, false);
  assert.match(r.warnings[0].text, /No strategy called/);
});

test('a strategy that throws is contained — the week still renders', () => {
  const ctx = fixtureContext();
  // Registered the way a real plug-in is, so this exercises the actual path.
  register({
    id: 'broken', name: 'Broken', blurb: 'Throws.', entries: 'single', params: [],
    run() { throw new Error('nope'); },
  });
  try {
    const r = run('broken', ctx);
    assert.equal(r.ok, false);
    assert.match(r.warnings[0].text, /Broken failed: nope/);
    assert.deepEqual(r.picks, [], 'and it produces nothing rather than something half-built');
  } finally {
    unregisterForTest('broken');
  }
});

test('a malformed strategy is refused at registration, not at first use', () => {
  assert.throws(
    () => register({ id: 'bad', name: 'Bad', entries: 'single' }),
    /Cannot register strategy/,
    'a plug-in with no run() must fail when the module loads, not on a Sunday',
  );
  assert.equal(getStrategy('bad'), null);
  assert.deepEqual(
    validateStrategy({ id: 'x', name: 'X', blurb: 'y', entries: 'single', run() {}, params: [{ key: 'k', label: 'K', type: 'nonsense', default: 1 }] }),
    ["strategy 'x' param 'k' has an unknown type 'nonsense'"],
  );
});

test('a default that breaks its own declaration is refused too', () => {
  // resolveParams clamps a *stored* value into range and returns an absent one
  // straight from `p.default`, untouched. So the default is the one number
  // that reaches a strategy unchecked -- and it is what every user runs until
  // they move the slider. The shape check is the only place it can be caught.
  const strategy = (param) => ({
    id: 'p', name: 'P', blurb: 'b', entries: 'single', run() {}, params: [{ key: 'k', label: 'K', ...param }],
  });

  assert.deepEqual(validateStrategy(strategy({ type: 'int', default: 12, min: 1, max: 8 })),
    ["strategy 'p' param 'k' defaults to 12, above its own max of 8"]);
  assert.deepEqual(validateStrategy(strategy({ type: 'int', default: 0, min: 1, max: 8 })),
    ["strategy 'p' param 'k' defaults to 0, below its own min of 1"]);
  assert.deepEqual(validateStrategy(strategy({ type: 'int', default: 2.5, min: 1, max: 8 })),
    ["strategy 'p' param 'k' is an int defaulting to 2.5"]);
  assert.deepEqual(validateStrategy(strategy({ type: 'percent', default: '65' })),
    ['strategy \'p\' param \'k\' is numeric with a default of "65"'],
    'a string that Number() would happily coerce is still a declaration mistake');
  assert.deepEqual(validateStrategy(strategy({ type: 'bool', default: 1 })),
    ["strategy 'p' param 'k' is a bool with a number default"]);
  assert.deepEqual(
    validateStrategy(strategy({ type: 'choice', default: 'c', options: [{ value: 'a' }, { value: 'b' }] })),
    ['strategy \'p\' param \'k\' defaults to "c", which is not one of its options']);

  assert.deepEqual(validateStrategy(strategy({ type: 'int', default: 4, min: 1, max: 8 })), [],
    'and a default inside its own range is simply fine');
});

test('every registered strategy defaults inside its own declared range', () => {
  // The live version of the test above. Nothing is out of range today; this is
  // what keeps it that way, and it is cheaper than finding out from a slider
  // that opens somewhere it cannot be dragged back to.
  assert.deepEqual(validateStrategies(), []);
});

/* ------------------------------------------------------------ comparing -- */

test('every strategy runs on one board, and agreement is reported', () => {
  const ctx = fixtureContext();
  const results = compareAll(ctx);
  assert.equal(results.length, STRATEGIES.length);
  for (const r of results) assert.equal(r.ok, true, `${r.strategyId} failed on a healthy board`);

  const agreement = agreementOf(results);
  for (const entry of ['A', 'B']) {
    assert.ok(agreement[entry], `no agreement row for ${entry}`);
    assert.equal(agreement[entry].rows.length, STRATEGIES.length);
  }
});

test('the lookahead is inert without a schedule, and live with one', () => {
  // The same assertion the parity suite makes about the Python, made here
  // about the engine the app actually runs.
  const withSeason = fixtureContext('season-2026', 3);
  const weekOnly = makeContext({
    season: 2026, week: 3, games: withSeason.games, usedTeams: { A: [], B: [] },
  });
  assert.equal(weekOnly.scheduleWeeks, 1);
  assert.ok(withSeason.scheduleWeeks > 1);

  const warned = run('value', weekOnly).warnings;
  assert.ok(
    warned.some((w) => /lookahead is doing nothing/.test(w.text)),
    'with one week loaded the value strategy must say it is not doing what it claims',
  );
  assert.ok(
    !run('value', withSeason).warnings.some((w) => /lookahead is doing nothing/.test(w.text)),
    'and say nothing about the lookahead when it is doing something',
  );
});

test('a per-entry strategy says when it has given both entries the same team', () => {
  // This asserted an empty warnings array and passed for the wrong reason:
  // the fixture puts both entries on MIN, which is the failure the warning
  // exists for, and the strategy was silent about it. Reasoning about two
  // entries one at a time converges on one team, because the ranking is
  // deterministic and they start the season with the same inventory -- the
  // backtester measures it at 100% of weeks until one of them dies.
  const ctx = fixtureContext('season-2026', 3);
  const result = run('value', ctx);
  const teams = result.picks.map((p) => p.candidate?.teamAbbreviation).filter(Boolean);
  assert.equal(new Set(teams).size, 1, 'the fixture is one where both entries converge');
  assert.ok(
    result.warnings.some((w) => /Both entries' top pick/.test(w.text)),
    'two entries in name only has to be said, not left for the reader to notice',
  );
});


/* ----------------------------------------------------- the source ladder -- */

/**
 * These mirror tests/test_win_prob.py. The parity suite already compares this
 * engine against the Python over a fixture that hits all four rungs, which is
 * the stronger check — but it only fires when the fixtures do, and a rung that
 * stopped being reachable would go quiet rather than red. This pins the ladder
 * directly, on this side, in the units the port is written in.
 */
const priced = ({ prob = null, spread = null, homeMl = null, awayMl = null }) => ({
  week: 3, seasonYear: 2026,
  home: { abbreviation: 'KC' }, away: { abbreviation: 'DEN' },
  probability: prob,
  odds: (spread === null && homeMl === null) ? null
    : { spread, homeMoneyline: homeMl, awayMoneyline: awayMl },
});

test('the two sides sum to more than 100, because a tie advances both', () => {
  // The property that catches a tie fix applied in the wrong direction. Once
  // a tie stops eliminating, the two sides advancing are no longer mutually
  // exclusive, so they must sum to 100 + P(tie). Exactly 100 would mean the
  // tie mass had been silently handed to the two winners.
  const home = winPctFromMoneylines(-280, 230, true);
  const away = winPctFromMoneylines(-280, 230, false);
  assert.ok(Math.abs(home + away - (100 + TIE_PROBABILITY * 100)) < 1e-6, `${home} + ${away}`);
  assert.ok(home > away);
  assert.ok(impliedProbFromMoneyline(-280) * 100 > home);
});

test('with a tie as a loss the pair sums to less than 100 instead', () => {
  const home = winPctFromMoneylines(-280, 230, true, 'power', true);
  const away = winPctFromMoneylines(-280, 230, false, 'power', true);
  assert.ok(Math.abs(home + away - (100 - TIE_PROBABILITY * 100)) < 1e-6, `${home} + ${away}`);
});

test('power reads the favourite higher than multiplicative', () => {
  // The whole reason the default is power: the favourite-longshot bias means
  // splitting the margin proportionally takes too much off the favourite, and
  // a survivor pick is nearly always the favourite.
  for (const m of DEVIG_METHODS) {
    const [h, a] = devig(0.7692, 0.3030, m);
    assert.ok(Math.abs(h + a - 1) < 1e-9, m);
  }
  const [mult] = devig(0.7692, 0.3030, 'multiplicative');
  const [add] = devig(0.7692, 0.3030, 'additive');
  const [pow] = devig(0.7692, 0.3030, 'power');
  assert.ok(pow > add && add > mult, `${pow} > ${add} > ${mult}`);
  assert.throws(() => devig(0.7, 0.35, 'shin-ish'));
});

test('a tie is worth exactly its own probability, and nothing is shrunk inside the free window', () => {
  assert.ok(Math.abs(
    (advanceProbability(0.8, false) - advanceProbability(0.8, true)) - TIE_PROBABILITY,
  ) < 1e-12);
  // Measured: a projection holds its accuracy about four weeks out.
  for (let w = 0; w <= 4; w += 1) assert.equal(shrinkTowardPrior(85, w), 85, `week +${w}`);
  assert.ok(shrinkTowardPrior(85, 5) < 85);
  assert.ok(shrinkTowardPrior(15, 8) > 15, 'shrinks toward even from below too');
});

test('one moneyline alone is not enough to price a game', () => {
  assert.equal(winPctFromMoneylines(-280, null, true), null);
  assert.equal(winPctFromMoneylines(0, 230, true), null);
});

test('the source ladder runs api → moneyline → spread → unknown', () => {
  const api = resolveTeamWinProbability(
    priced({ prob: { homeWinPct: 0.78, awayWinPct: 0.22 }, spread: -6.5, homeMl: -280, awayMl: 230 }), true,
  );
  assert.equal(api.source, 'api');

  const market = resolveTeamWinProbability(priced({ spread: -6.5, homeMl: -280, awayMl: 230 }), true);
  assert.equal(market.source, 'moneyline');

  const est = resolveTeamWinProbability(priced({ spread: -6.5 }), true);
  assert.equal(est.source, 'spread_estimate');

  const none = resolveTeamWinProbability(priced({}), true);
  assert.equal(none.source, 'unknown');
  assert.equal(none.winPct, null);
});

test('the spread curve is monotonic and no longer calls a 14-point favourite a coin flip', () => {
  const pcts = Array.from({ length: 21 }, (_, i) => estimateWinPctFromSpread(-i, true));
  for (let i = 1; i < pcts.length; i += 1) assert.ok(pcts[i] >= pcts[i - 1]);
  assert.ok(estimateWinPctFromSpread(-14, true) > 85);
  // The two sides account for all the probability. Not a mirror around 50 any
  // more: the tie belongs to both of them here.
  assert.ok(Math.abs(
    estimateWinPctFromSpread(-7, true) + estimateWinPctFromSpread(-7, false)
    - (100 + TIE_PROBABILITY * 100),
  ) < 1e-6);
});

test('every source names itself, or is deliberately silent', () => {
  assert.equal(basisPhrase('spread_estimate'), ' (estimated from spread)');
  assert.equal(basisPhrase('moneyline'), ' (de-vigged moneyline)');
  assert.equal(basisPhrase('api'), '');
  assert.equal(basisPhrase('unknown'), '');
});

/* ------------------------------------------------- the search's ceiling -- */

test('the sequence search refuses more teams than its bitmask can hold', async () => {
  // The teams-used set is a bitmask and JavaScript shifts on 32-bit signed
  // integers, so `1 << 32` is 1: team 32 would share a bit with team 0 and the
  // search would call a plan illegal over a team it never spent. Python's mask
  // is arbitrary precision, so the parity fixtures could never report this --
  // the two engines would simply disagree with nothing to say why.
  //
  // Unreachable through the registry: the declared caps are 20 teams over 12
  // weeks and the soft cap adds back at most one per week, which is exactly
  // 32. `solve` is exported and takes its options from the caller, so the
  // ceiling is enforced rather than assumed.
  const { solve } = await import('../deadpool/src/engine/strategies/sequence-dp.js');
  const weekOf = (n) => Array.from({ length: n }, (_, i) => ({
    week: 1, teamAbbreviation: `T${String(i).padStart(2, '0')}`, winPct: 60 + i * 0.1,
  }));

  const atTheLimit = solve(new Map([[1, weekOf(32)], [2, weekOf(32)]]), 50);
  assert.equal(new Set(atTheLimit.path.map((p) => p.teamAbbreviation)).size, atTheLimit.path.length,
    'at 32 teams a plan must still spend each of them once');

  assert.throws(
    () => solve(new Map([[1, weekOf(33)]]), 50),
    /at most 32 teams/,
  );
});

test('the beam keeps the plan it has to be able to rank', async () => {
  // The dedup key is `(teams used, running product)`. The second half looks
  // redundant -- a mask names a set of teams, and a product of the same teams
  // is the same product -- and it is not, because a team's probability depends
  // on the *week* it is spent in. Two plans can use the same two teams in
  // opposite orders and carry very different products.
  //
  // Collapsing the key to the mask alone passed this suite, the Python suite
  // and all ten golden fixtures. This board is where it does not: the plan
  // that is behind after two weeks is the one that wins over three, because it
  // carries forty times the product into the last of them.
  const { solve } = await import('../deadpool/src/engine/strategies/sequence-dp.js');
  const pick = (week, teamAbbreviation, winPct) => ({
    week, teamAbbreviation, opponentAbbreviation: 'X', isHome: true,
    winPct, winPctSource: 'api', winPctIsEstimated: false, spreadDetail: null, eventId: null,
  });
  const weekly = new Map([
    [1, [pick(1, 'BUF', 70), pick(1, 'ARI', 30)]],
    [2, [pick(2, 'BUF', 99), pick(2, 'ARI', 1)]],
    [3, [pick(3, 'CHI', 99)]],
  ]);

  const over3 = solve(weekly, 50);
  assert.deepEqual(over3.path.map((p) => p.teamAbbreviation), ['ARI', 'BUF', 'CHI']);
  assert.ok(Math.abs(over3.expectedWeeks - 0.891) < 1e-3, `${over3.expectedWeeks}`);

  // Genuinely behind at two weeks, which is what makes it a real test rather
  // than a tie broken one way.
  const over2 = solve(new Map([[1, weekly.get(1)], [2, weekly.get(2)]]), 50);
  assert.deepEqual(over2.path.map((p) => p.teamAbbreviation), ['BUF', 'ARI']);
  assert.ok(Math.abs(over2.expectedWeeks - 0.707) < 1e-3, `${over2.expectedWeeks}`);
});

/* ------------------------------------------------------------ measured -- */

test('every strategy says where it sits in the backtest, or says nobody measured it', () => {
  // The repository is called algorithm-testing and the settings screen listed
  // six strategies as equals. Not publishing the results on the one screen
  // where somebody chooses between the algorithms was the gap this closes.
  //
  // `null` is a legal answer -- every strategy currently carries a figure, so
  // that branch is dormant and stays for the next one added. What is refused
  // is *absence*: a strategy simply missing from the table would be presented
  // with no rating and nothing would say it had never been raced.
  //
  // The guard is here rather than in register(), which stays a pure shape
  // check -- making registration depend on a core table would mean a strategy
  // could not be added without editing one, and the picker already renders a
  // missing entry honestly as "not measured". The suite is where the pile of
  // unmeasured things is kept visible.
  for (const s of listStrategies()) {
    assert.ok(s.id in MEASURED, `${s.id} is missing from engine/measured.js`);
    const m = MEASURED[s.id];
    if (m === null) continue;
    assert.ok(Number.isFinite(m.xFair) && m.xFair > 0, `${s.id}.xFair must be a positive multiple`);
    assert.ok(typeof m.note === 'string' && m.note, `${s.id} has a number and no explanation of it`);
  }
});

test('the table describes strategies that exist', () => {
  // The other direction. A renamed strategy leaves its old result behind,
  // where it rates nothing and looks like evidence.
  const ids = new Set(listStrategies().map((s) => s.id));
  for (const id of Object.keys(MEASURED)) {
    assert.ok(ids.has(id), `engine/measured.js rates '${id}', which is not a registered strategy`);
  }
});

test('a blurb that names another strategy names one that exists', () => {
  // Same guard as the note test below, for the text that is actually on the
  // picker screen. `leverage` describes itself in terms of `{distinct}`, and a
  // display name written out longhand would be the same fact in two files —
  // rename the strategy and the sentence quoting it describes something that
  // no longer exists, with nothing failing.
  const ids = new Set(listStrategies().map((s) => s.id));
  for (const s of listStrategies()) {
    for (const [, referenced] of (s.blurb ?? '').matchAll(/\{(\w+)\}/g)) {
      assert.ok(ids.has(referenced),
        `${s.id}'s blurb cites {${referenced}}, which is not a registered strategy — it would render with the braces showing`);
    }
  }
});

test('no strategy claims it can pair the two entries inside one game unless it can', () => {
  // The blurb for `joint` said it was "the only one that can put your two
  // entries on opposite sides of the same game". It is the only one that
  // CANNOT — joint-optimizer.js skips sameGame pairs by design, eleven lines
  // above the sentence claiming otherwise, and distinct.js had the true
  // version all along. It was wrong on the picker screen at the moment
  // somebody chooses, which sent anyone wanting that hedge to the one
  // strategy structurally refusing to give it.
  //
  // Asserted rather than merely fixed, because the claim is attractive and
  // easy to write again.
  const joint = getStrategy('joint');
  assert.ok(joint, 'joint should still be registered');
  assert.ok(!/opposite sides|same game|one game/i.test(joint.blurb),
    `joint's blurb claims something about pairing inside one game: ${joint.blurb}`);
});

test('a note that names another strategy names one that exists', () => {
  // measured.js writes `{joint}` rather than a display name on purpose: the
  // name in two files is how this drifts, and the note is meant to resolve to
  // whatever that strategy is currently called. settings.js falls back to the
  // literal `{joint}` when the id is gone, so a rename does not throw -- it
  // ships a note with a brace in it. Nothing caught that, which is the same
  // gap tests/test_measured_table.py exists to close for `pair:`.
  const ids = new Set(listStrategies().map((s) => s.id));
  for (const [id, m] of Object.entries(MEASURED)) {
    for (const [, referenced] of (m?.note ?? '').matchAll(/\{(\w+)\}/g)) {
      assert.ok(ids.has(referenced),
        `${id}'s note cites {${referenced}}, which is not a registered strategy — it would render with the braces showing`);
    }
  }
});

test('the run that produced the numbers is recorded with them', () => {
  // A rating whose provenance is a chat transcript is exactly the confident
  // sentence this repository distrusts everywhere else. The command has to be
  // in the file, next to the numbers it produced.
  assert.ok(RUN.seasons >= 2000, 'a smaller sample than this has already falsified two strategies');
  assert.match(RUN.command, /backtest\.py/);
  assert.match(RUN.command, new RegExp(String(RUN.seasons)), 'the command must name the sample it produced');
});
