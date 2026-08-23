/**
 * The JavaScript engine must say exactly what the Python engine says.
 *
 * This is the test that makes "the picking algorithms were not changed" a fact
 * rather than a claim. `fixtures/golden/` is written by scripts/gen-golden.py,
 * which drives the real Python modules over the real parser in
 * data/espn_client.py. Here the same fixtures go through deadpool/src/engine/,
 * and every pick, every ordering and every sentence of reasoning is compared.
 *
 * ── What is compared, and how strictly ──────────────────────────────────
 *
 * Strings exactly. The reasoning is what a person reads on a Sunday, so
 * "12.4 points better" and "12.5 points better" are a failure, and
 * deadpool/src/engine/fmt.js exists because JavaScript's toFixed rounds halves
 * away from zero where Python rounds them to even.
 *
 * Orderings exactly, as full sequences of abbreviations rather than just the
 * winner. A sort ported loosely usually still gets the top pick right; it gets
 * position nine wrong, which is invisible until a week when position nine is
 * the only legal option left.
 *
 * Numbers to a relative 1e-9. Both languages evaluate the same IEEE-754
 * arithmetic and in practice agree bit for bit — 0.85**5 is
 * 0.44370531249999995 in both — but `pow` is not required to be correctly
 * rounded and V8 does not share libm's implementation, so a last-ulp
 * difference in the decay weight is possible. 1e-9 is seven orders of
 * magnitude looser than that and still far tighter than anything that could
 * change a displayed figure or a ranking.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGames, parseProbability, parseOdds } from '../deadpool/src/engine/espn.js';
import { buildWinProbabilityTable } from '../deadpool/src/engine/win-prob.js';
import * as ranked from '../deadpool/src/engine/strategies/recommender.js';
import * as value from '../deadpool/src/engine/strategies/entry-a-value.js';
import * as hedge from '../deadpool/src/engine/strategies/entry-b-hedge.js';
import * as joint from '../deadpool/src/engine/strategies/joint-optimizer.js';
import * as sequence from '../deadpool/src/engine/strategies/sequence-dp.js';
import * as distinct from '../deadpool/src/engine/strategies/distinct.js';
import { ABBRS } from '../deadpool/src/data/teams.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const SPEC = read('fixtures/parity-spec.json');

const TOP_N = 3;   // must match gen-golden.py

/* ------------------------------------------------------------- loading -- */

/** A fixture as { week: bundle }, whether it holds a season or one week. */
function weeksOf(name) {
  const raw = read(`fixtures/weeks/${name}.json`);
  if (raw.weeks) return new Map(Object.entries(raw.weeks).map(([w, b]) => [Number(w), b]));
  return new Map([[Number(raw.meta.week), { scoreboard: raw.scoreboard, probabilities: raw.probabilities, odds: raw.odds }]]);
}

function gamesFrom(bundle) {
  const games = parseGames(bundle.scoreboard);
  for (const g of games) {
    g.probability = parseProbability(bundle.probabilities[g.eventId] ?? null);
    g.odds = parseOdds(bundle.odds[g.eventId] ?? null);
  }
  return games;
}

/* ------------------------------------------------------- serialisation -- */
/* Deliberately the same shape gen-golden.py writes, so the comparison is of
   values rather than of two naming conventions meeting in the middle. */

const candidate = (c) => (c === null || c === undefined ? null : {
  team: c.teamAbbreviation,
  opponent: c.opponentAbbreviation,
  winPct: c.winPct,
  // PickCandidate in the Python carries only a boolean, so it resolves to
  // 'spread_estimate' or nothing; the other three carry the source outright.
  source: c.winPctSource ?? (c.winPctIsEstimated ? 'spread_estimate' : null),
  spread: c.spreadDetail,
  eventId: c.eventId ?? null,
});

const rankedCandidate = (c) => {
  const d = candidate(c);
  if (d) d.source = c.winPctIsEstimated ? 'spread_estimate' : null;
  return d;
};

function rankedPick(p) {
  if (!p) return null;
  const d = candidate(p);
  delete d.eventId;          // RankedPick has no event id in the Python either
  d.futureValue = p.futureValue;
  d.penalty = p.futureValuePenalty;
  d.score = p.score;
  return d;
}

const orderOf = (items) => items.map((i) => i.teamAbbreviation);

/* ------------------------------------------------------------ the runs -- */

function actualFor(spec) {
  const byWeek = weeksOf(spec.fixture);
  const week = spec.week;
  const games = gamesFrom(byWeek.get(week));

  const scheduleGames = spec.scheduleWeeks === 'all'
    ? [...byWeek.keys()].sort((a, b) => a - b).flatMap((w) => gamesFrom(byWeek.get(w)))
    : games;
  const table = buildWinProbabilityTable(scheduleGames);

  const { usedA, usedB } = spec;
  const out = { runId: spec.id };

  // 1. ranked
  const recs = ranked.recommendForEntries(games, { A: usedA, B: usedB }, 32);
  out.ranked = {
    A: { order: orderOf(recs.A), top: recs.A.slice(0, TOP_N).map(rankedCandidate) },
    B: { order: orderOf(recs.B), top: recs.B.slice(0, TOP_N).map(rankedCandidate) },
    conflict: ranked.findConflicts({ A: recs.A.slice(0, 1), B: recs.B.slice(0, 1) }),
  };

  // 2. value
  out.value = {};
  for (const [entry, used] of [['A', usedA], ['B', usedB]]) {
    const r = value.recommend(games, table, week, used);
    const list = r.pick ? [r.pick, ...r.alternatives] : [];
    out.value[entry] = {
      week: r.week,
      pick: rankedPick(r.pick),
      reasoning: r.reasoning,
      order: orderOf(list),
      top: list.slice(0, TOP_N).map(rankedPick),
    };
  }

  // 3. sequence — the plan, not just its first step
  out.sequence = {};
  for (const [entry, used] of [['A', usedA], ['B', usedB]]) {
    const r = sequence.recommend(games, table, week, used);
    out.sequence[entry] = {
      week: r.week,
      pick: candidate(r.pick),
      reasoning: r.reasoning,
      survivalPct: r.survivalPct,
      path: r.path.map((p) => ({ week: p.week, team: p.teamAbbreviation, winPct: p.winPct })),
      universe: r.candidateUniverse,
    };
  }

  // 4. hedge, against whatever value just decided for A
  const aPick = value.recommend(games, table, week, usedA).pick;
  const aTeam = aPick ? aPick.teamAbbreviation : null;
  const h = hedge.recommend(games, week, usedB, aTeam);
  const hList = h.pick ? [h.pick, ...h.alternatives] : [];
  out.hedge = {
    entryAPick: aTeam,
    week: h.week,
    pick: candidate(h.pick),
    reasoning: h.reasoning,
    floorRelaxed: h.floorRelaxed,
    order: orderOf(hList),
    top: hList.slice(0, TOP_N).map(candidate),
  };

  // 4. joint
  const j = joint.recommend(games, week, usedA, usedB);
  out.joint = {
    week: j.week,
    pickA: candidate(j.pickA),
    pickB: candidate(j.pickB),
    bothSurvivePct: j.bothSurvivePct,
    oneSurvivesPct: j.oneSurvivesPct,
    bothEliminatedPct: j.bothEliminatedPct,
    reasoning: j.reasoning,
    floorRelaxed: j.floorRelaxed,
    pairsConsidered: j.pairsConsidered,
  };

  // 5. distinct — one strategy for both entries, minus a collision.
  //    `collided` is compared too: it is the whole difference between this and
  //    running `sequence` twice, and a port agreeing on the teams while
  //    disagreeing on whether the rule bound is a different strategy wearing
  //    the same answer.
  const A = 'Entry A';
  const B = 'Entry B';
  const d = distinct.recommendDistinct(
    games, table, week, { [A]: usedA, [B]: usedB }, [A, B],
  );
  out.distinct = {
    week,
    picks: Object.fromEntries(Object.entries(d.picks).map(([e, pk]) => [e, candidate(pk)])),
    reasoning: d.reasoning,
    collided: d.collided,
  };

  return out;
}

/* ---------------------------------------------------------- comparison -- */

const EPS = 1e-9;

function matches(actual, expected, path = '') {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const tol = Math.max(EPS, Math.abs(expected) * EPS);
    assert.ok(
      Math.abs(actual - expected) <= tol,
      `${path}: ${actual} is not within ${tol} of Python's ${expected}`,
    );
    return;
  }
  if (expected === null || typeof expected !== 'object') {
    assert.equal(actual, expected, `${path}: got ${JSON.stringify(actual)}, Python said ${JSON.stringify(expected)}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array`);
    assert.equal(actual.length, expected.length, `${path}: length ${actual.length}, Python said ${expected.length}`);
    expected.forEach((e, i) => matches(actual[i], e, `${path}[${i}]`));
    return;
  }
  assert.deepEqual(
    Object.keys(actual ?? {}).sort(), Object.keys(expected).sort(),
    `${path}: the two engines produced different fields`,
  );
  for (const k of Object.keys(expected)) matches(actual[k], expected[k], path ? `${path}.${k}` : k);
}

/* --------------------------------------------------------------- tests -- */

test('the golden files exist — run `npm run golden` if not', () => {
  for (const spec of SPEC.runs) {
    assert.ok(
      existsSync(join(ROOT, `fixtures/golden/${spec.id}.json`)),
      `fixtures/golden/${spec.id}.json is missing. The parity suite is meaningless without it.`,
    );
  }
});

for (const spec of SPEC.runs) {
  test(`parity: ${spec.id} — ${spec.why}`, () => {
    matches(actualFor(spec), read(`fixtures/golden/${spec.id}.json`), spec.id);
  });
}

test('the lookahead is live when a season is loaded, and inert when it is not', () => {
  // Not a parity assertion — a guard on the fixtures themselves. If these two
  // runs ever produce the same ranking, the season fixture has stopped
  // exercising future-value and every parity run above would still pass while
  // proving less than it claims to.
  const withSeason = read('fixtures/golden/w01-fresh.json');
  const weekOnly = read('fixtures/golden/w01-no-schedule.json');

  assert.equal(weekOnly.value.A.pick.futureValue, null,
    'with one week loaded, futureValue must be null — this is the CLI behaviour the app fixes');
  assert.notEqual(withSeason.value.A.pick.futureValue, null,
    'with the season loaded, futureValue must be a number, or the lookahead is doing nothing');
  assert.notDeepEqual(withSeason.value.A.order, weekOnly.value.A.order,
    'the lookahead must change the ranking, or the fixture is not exercising it');
});

test('the JavaScript team list matches the Python one, abbreviation for abbreviation', () => {
  // data/teams.py and deadpool/src/data/teams.js are one fact written down
  // twice, and they have to be: the browser cannot import Python. What makes
  // that safe is this assertion rather than care.
  //
  // The failure it prevents is silent and specific. ESPN's abbreviations are
  // not the familiar ones for four teams — WSH not WAS, LAR not LA, LV not
  // LVR, JAX not JAC — and getting one wrong throws nothing. It produces a
  // board cell that never lights up and a team that can be picked twice.
  const expected = read('test/nfl-teams.json').nflTeams;
  assert.deepEqual(
    [...ABBRS].sort(), [...expected].sort(),
    'deadpool/src/data/teams.js has drifted from data/teams.py',
  );
  assert.equal(ABBRS.length, 32, 'the league has 32 teams');
});
