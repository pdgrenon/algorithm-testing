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
import { buildOptions, unavailableOptions, isPickable, byWinPctDesc } from '../deadpool/src/engine/constraints.js';
import { parseGames, parseProbability, parseOdds } from '../deadpool/src/engine/espn.js';

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
  assert.ok(STRATEGIES.length >= 4, 'the four ported strategies should all be registered');
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
  assert.deepEqual(run('value', withSeason).warnings, [], 'and say nothing when it is');
});
