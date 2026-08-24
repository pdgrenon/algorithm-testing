/**
 * The win-probability model's two optional corrections, in the browser engine.
 *
 * Three things are being held here, in descending order of how much they
 * matter:
 *
 *   1. **Off is bit-identical.** Everything in engine/measured.js was measured
 *      with both corrections off, so wiring them in had to move nothing. Most
 *      of this file is that one property, checked from several directions.
 *
 *   2. **On reaches everywhere.** The engine resolves probabilities in two
 *      independent places — the season table in makeContext, and the current
 *      week's board in constraints.buildOptions — and a correction that
 *      reached one but not the other would put two different numbers on the
 *      same game in one render. That is not hypothetical: it is what the first
 *      version of this change did.
 *
 *   3. **The candidate carries it.** Every strategy rebuilds its candidates
 *      from an explicit field list, so a new field reaches the screen only if
 *      each of them passes it through. The first version of this change did
 *      not, and the Week screen drew nothing while every test passed.
 *
 * The arithmetic itself is tested against the Python oracle in
 * tests/test_elo.py and through the golden fixtures in parity.test.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as elo from '../deadpool/src/engine/elo.js';
import { biasFor, TEAM_BIAS_TABLE, venueKey } from '../deadpool/src/engine/team-bias.js';
import { parseNfeloSeason } from '../deadpool/src/engine/nfelo.js';
import {
  resolveTeamWinProbability, buildWinProbabilityTable, marketHomeShare,
  spreadLineFromHomeShare, homeShareFromSpreadLine,
} from '../deadpool/src/engine/win-prob.js';
import { buildOptions } from '../deadpool/src/engine/constraints.js';
import {
  makeContext, run, listStrategies, MODEL_PARAMS, resolveModelParams, defaultModelParams,
} from '../deadpool/src/engine/index.js';
import { TEAMS } from '../deadpool/src/data/teams.js';

/* ---------------------------------------------------------------- helpers -- */

const game = ({
  home = 'NYG', away = 'DAL', season = 2026, week = 1, spread = -6.5,
  homeMoneyline = -280, awayMoneyline = 230, probability = null, state = 'pre',
} = {}) => ({
  eventId: `${home}-${away}-${week}`,
  week,
  seasonYear: season,
  state,
  startDate: '2026-09-13T17:00:00Z',
  home: { abbreviation: home, displayName: home },
  away: { abbreviation: away, displayName: away },
  odds: { spread, homeMoneyline, awayMoneyline, details: `${home} ${spread}` },
  probability,
});

const ELO = { '2026_01_DAL_NYG': 0.60 };

/* ------------------------------------------------------------- the parse -- */

test('nfelo game ids are away-first with a padded week, and translate relocations', () => {
  assert.equal(elo.nfeloGameId(2026, 1, 'DAL', 'NYG'), '2026_01_DAL_NYG');
  assert.equal(elo.nfeloGameId(2026, 12, 'DAL', 'NYG'), '2026_12_DAL_NYG');
  // The three that differ are all teams that moved. A wrong one here does not
  // throw — it silently never matches.
  assert.equal(elo.nfeloGameId(2026, 1, 'LV', 'WSH'), '2026_01_OAK_WAS');
  assert.equal(elo.nfeloGameId(2026, 1, 'LAR', 'KC'), '2026_01_LAR_KC');
});

test('a row nfelo cannot answer for is skipped, not defaulted', () => {
  const table = elo.parseNfeloRows([
    { game_id: '2026_01_DAL_NYG', nfelo_home_probability_close: '0.62' },
    { game_id: 'nope', nfelo_home_probability_close: '0.5' },
    { game_id: '2026_01_KC_DEN', nfelo_home_probability_close: '' },
    { game_id: '2026_01_SF_SEA', nfelo_home_probability_close: 'NA' },
    { game_id: '2026_01_GB_CHI', nfelo_home_probability_close: '1.4' },
  ]);
  assert.deepEqual(table, { '2026_01_DAL_NYG': 0.62 });
});

test('the CSV parser takes one season and survives a file it cannot read', () => {
  const csv = [
    ',game_id,nfelo_home_probability_close',
    '0,2026_01_DAL_NYG,0.62',
    '1,2025_01_DAL_NYG,0.55',
    '2,2026_02_KC_DEN,0.71',
  ].join('\n');

  assert.deepEqual(parseNfeloSeason(csv, 2026), {
    '2026_01_DAL_NYG': 0.62,
    '2026_02_KC_DEN': 0.71,
  });
  assert.deepEqual(parseNfeloSeason(csv, 2024), {}, 'a season it does not cover');
  assert.deepEqual(parseNfeloSeason('', 2026), {}, 'an empty file');
  assert.deepEqual(parseNfeloSeason('a,b,c\n1,2,3', 2026), {}, 'no probability column');
});

/* -------------------------------------------------------- off means off -- */

test('with no options, every field of the model working is empty', () => {
  const r = resolveTeamWinProbability(game(), true);
  assert.equal(r.eloSpread, null);
  assert.equal(r.divergence, null);
  assert.equal(r.teamBiasPct, 0);
  assert.equal(r.marketWinPct, r.winPct, 'nothing moved it');
});

test('an Elo table at full market weight moves no number at all', () => {
  for (const isHome of [true, false]) {
    const before = resolveTeamWinProbability(game(), isHome);
    const after = resolveTeamWinProbability(game(), isHome, undefined, undefined, {
      eloTable: ELO, marketWeight: 1,
    });
    assert.equal(after.winPct, before.winPct);
    // ...and the divergence still arrives, because it is information rather
    // than a decision and is not gated on the weight.
    assert.ok(after.divergence !== null, 'divergence is reported at 100% market');
  }
});

test('a bias table with no entry for the team changes nothing', () => {
  const before = resolveTeamWinProbability(game(), true);
  const after = resolveTeamWinProbability(game(), true, undefined, undefined, {
    biasTable: { NOPE: { home: 3, away: 3 } },
  });
  assert.equal(after.winPct, before.winPct);
  assert.equal(after.teamBiasPct, 0);
});

test('the default model settings are the ones every rating was measured at', () => {
  assert.deepEqual(defaultModelParams(), { marketWeight: 100, teamBias: false });
});

/* ------------------------------------------------------------- the blend -- */

test('the blend moves both sides of a game by the same amount, oppositely', () => {
  const opts = { eloTable: ELO, marketWeight: 0.5 };
  const plain = [true, false].map((h) => resolveTeamWinProbability(game(), h).winPct);
  const blended = [true, false].map(
    (h) => resolveTeamWinProbability(game(), h, undefined, undefined, opts).winPct,
  );
  assert.ok(Math.abs((blended[0] + blended[1]) - (plain[0] + plain[1])) < 1e-9,
    'a game\'s two rows must keep summing the way they did');
  assert.notEqual(blended[0], plain[0], 'the blend should actually have done something');
});

test('one game gives one divergence, whichever side is asked about', () => {
  const opts = { eloTable: ELO, marketWeight: 0.5 };
  const home = resolveTeamWinProbability(game(), true, undefined, undefined, opts);
  const away = resolveTeamWinProbability(game(), false, undefined, undefined, opts);
  assert.equal(home.divergence, away.divergence);
  assert.equal(home.marketSpread, away.marketSpread);
});

test('a game nfelo has not rated stays on the market while its neighbour blends', () => {
  const opts = { eloTable: ELO, marketWeight: 0.5 };
  const rated = resolveTeamWinProbability(game(), true, undefined, undefined, opts);
  const unratedGame = game({ home: 'KC', away: 'DEN' });
  const unrated = resolveTeamWinProbability(unratedGame, true, undefined, undefined, opts);

  assert.ok(rated.divergence !== null);
  assert.equal(unrated.divergence, null);
  assert.equal(unrated.winPct, resolveTeamWinProbability(unratedGame, true).winPct);
});

test('the market share is on the no-tie scale even from ESPN\'s three-way split', () => {
  const g = game({ probability: { homeWinPct: 0.70, awayWinPct: 0.28, tiePct: 0.02 } });
  // 0.70 / 0.98, not 0.70 — otherwise a figure including the tie would be
  // compared against an Elo probability that excludes it.
  assert.ok(Math.abs(marketHomeShare(g) - (0.70 / 0.98)) < 1e-12);
});

/* -------------------------------------------------------------- the bias -- */

test('the shipped bias table covers exactly this app\'s teams', () => {
  const abbrs = TEAMS.map((t) => t.abbr).sort();
  assert.deepEqual(Object.keys(TEAM_BIAS_TABLE).sort(), abbrs);
});

test('every shipped adjustment is small enough to be the empirical-Bayes one', () => {
  // A tripwire, not a claim that 0.5 is correct: the current largest is 0.17,
  // so anything past half a point means the estimator or the sample changed.
  for (const [team, contexts] of Object.entries(TEAM_BIAS_TABLE)) {
    for (const [venue, points] of Object.entries(contexts)) {
      assert.ok(Math.abs(points) < 0.5, `${team} ${venue} is ${points}`);
    }
  }
});

test('a bias lookup returns zero for anything it does not recognise', () => {
  assert.equal(biasFor(null, 'KC', true), 0);
  assert.equal(biasFor({}, 'KC', true), 0);
  assert.equal(biasFor(TEAM_BIAS_TABLE, 'NOPE', true), 0);
  assert.equal(biasFor(TEAM_BIAS_TABLE, null, true), 0);
  assert.equal(biasFor({ KC: {} }, 'KC', true), 0);
  assert.equal(venueKey(true), 'home');
  assert.equal(venueKey(false), 'away');
});

test('the bias is applied with the sign the table gives it', () => {
  const opts = { biasTable: { NYG: { home: 2.0, away: -2.0 } } };
  const plain = resolveTeamWinProbability(game(), true).winPct;
  const nudged = resolveTeamWinProbability(game(), true, undefined, undefined, opts);
  assert.ok(nudged.winPct > plain, 'a positive home bias should raise a home team');
  assert.ok(Math.abs(nudged.teamBiasPct - 2.0) < 1e-12);
});

/* ------------------------------------------- the two resolution paths -- */

test('the season table and the current-week board agree on the same game', () => {
  // The engine resolves probabilities twice, independently: makeContext builds
  // the season table, and constraints.buildOptions builds the week's board.
  // A correction reaching one and not the other puts two numbers on one game.
  const games = [game()];
  const opts = { eloTable: ELO, marketWeight: 0.5, biasTable: TEAM_BIAS_TABLE };

  const table = buildWinProbabilityTable(games, opts);
  const fromTable = table.get('NYG|1');
  const fromBoard = buildOptions(games, opts).find((o) => o.teamAbbreviation === 'NYG');

  assert.equal(fromBoard.winPct, fromTable.winPct);
  assert.equal(fromBoard.divergence, fromTable.divergence);
  assert.equal(fromBoard.teamBiasPct, fromTable.teamBiasPct);
});

test('makeContext hands the same options to both paths', () => {
  const games = [game()];
  const ctx = makeContext({
    season: 2026, week: 1, games, eloTable: ELO,
    model: { marketWeight: 50, teamBias: true },
  });

  assert.equal(ctx.model.marketWeight, 50);
  assert.equal(ctx.model.teamBias, true);
  assert.equal(ctx.modelOpts.marketWeight, 0.5, 'stored as a percent, used as a fraction');
  assert.ok(ctx.modelOpts.biasTable, 'the bias table is attached when the toggle is on');
  assert.equal(ctx.eloRated, 1);

  const board = buildOptions(games, ctx.modelOpts).find((o) => o.teamAbbreviation === 'NYG');
  assert.equal(board.winPct, ctx.schedule.get('NYG|1').winPct);
});

test('the Elo table reaches the context even at full market weight', () => {
  // Divergence is not gated on the blend, so a context built with the blend
  // off still has to be able to report it.
  const ctx = makeContext({
    season: 2026, week: 1, games: [game()], eloTable: ELO,
    model: { marketWeight: 100, teamBias: false },
  });
  assert.equal(ctx.modelOpts.eloTable, ELO);
  assert.ok(ctx.schedule.get('NYG|1').divergence !== null);
});

/* ------------------------------------------------ every strategy carries it -- */

test('every strategy puts the model working onto the candidates it returns', () => {
  // The failure this exists for: a strategy rebuilds its candidates from an
  // explicit field list, so a new field reaches the Week screen only if that
  // list passes it through. When they did not, the screen drew nothing and
  // the whole suite stayed green.
  const games = [
    game({ home: 'NYG', away: 'DAL' }),
    game({ home: 'KC', away: 'DEN' }),
    game({ home: 'SF', away: 'SEA' }),
    game({ home: 'BUF', away: 'MIA' }),
  ];
  const eloTable = {
    '2026_01_DAL_NYG': 0.60,
    '2026_01_DEN_KC': 0.80,
    '2026_01_SEA_SF': 0.55,
    '2026_01_MIA_BUF': 0.70,
  };

  const ctx = makeContext({
    season: 2026, week: 1, games, scheduleGames: games, eloTable,
    model: { marketWeight: 50, teamBias: true },
  });

  for (const strategy of listStrategies()) {
    const result = run(strategy.id, ctx, {});
    for (const pick of result.picks) {
      if (!pick.candidate) continue;
      const where = `${strategy.id} / ${pick.entry}`;
      assert.ok(typeof pick.candidate.isHome === 'boolean', `${where}: isHome missing`);
      assert.ok(Number.isFinite(pick.candidate.marketSpread),
        `${where}: marketSpread missing — the Week screen draws nothing without it`);
      assert.ok(Number.isFinite(pick.candidate.divergence),
        `${where}: divergence missing`);
      assert.ok(Number.isFinite(pick.candidate.teamBiasPct),
        `${where}: teamBiasPct missing`);
    }
  }
});

test('turning both corrections on changes what at least one strategy picks', () => {
  // Otherwise the settings are decorative. Deliberately a weak assertion —
  // it says the wiring is live, not that the corrections are any good.
  const games = [
    game({ home: 'NYG', away: 'DAL', spread: -1.5, homeMoneyline: -125, awayMoneyline: 105 }),
    game({ home: 'KC', away: 'DEN', spread: -2.0, homeMoneyline: -135, awayMoneyline: 115 }),
  ];
  const eloTable = { '2026_01_DAL_NYG': 0.95, '2026_01_DEN_KC': 0.20 };

  const off = makeContext({ season: 2026, week: 1, games, scheduleGames: games });
  const on = makeContext({
    season: 2026, week: 1, games, scheduleGames: games, eloTable,
    model: { marketWeight: 0, teamBias: false },
  });

  const pickOf = (ctx) => run('ranked', ctx, {}).picks[0].candidate.teamAbbreviation;
  assert.notEqual(pickOf(on), pickOf(off));
});

/* --------------------------------------------------- the declared controls -- */

test('the model parameters are declared in the shape the settings screen renders', () => {
  const keys = MODEL_PARAMS.map((p) => p.key);
  assert.deepEqual(keys, ['marketWeight', 'teamBias']);
  for (const p of MODEL_PARAMS) {
    assert.ok(p.label, `${p.key} has no label`);
    assert.ok(p.help, `${p.key} has no help text`);
    assert.ok(['int', 'float', 'percent', 'bool', 'choice'].includes(p.type),
      `${p.key} has an unknown type`);
    assert.notEqual(p.default, undefined, `${p.key} has no default`);
  }
});

test('a stored model setting is clamped back into what is declared', () => {
  assert.deepEqual(resolveModelParams({ marketWeight: 500 }),
    { marketWeight: 100, teamBias: false });
  assert.deepEqual(resolveModelParams({ marketWeight: -20 }),
    { marketWeight: 0, teamBias: false });
  assert.deepEqual(resolveModelParams({ marketWeight: 'nonsense' }),
    { marketWeight: 100, teamBias: false });
  assert.deepEqual(resolveModelParams({ teamBias: 'yes' }),
    { marketWeight: 100, teamBias: true });
  assert.deepEqual(resolveModelParams({}), defaultModelParams());
});

test('the blend weight steps land on the five mixes the control offers', () => {
  const p = MODEL_PARAMS.find((x) => x.key === 'marketWeight');
  assert.equal((p.max - p.min) % p.step, 0,
    'the step has to divide the range or the slider cannot reach its own maximum');
  assert.equal((p.max - p.min) / p.step + 1, 5);
});

/* ---------------------------------------------------------------- purity -- */

test('the lookahead range reaches the short plans as well as the long ones', () => {
  // Widened to 1 so a two-week plan — the configuration a sibling project
  // settled on — is reachable, and so a one-week plan can be compared against
  // it without editing the source.
  for (const s of listStrategies()) {
    const p = (s.params ?? []).find((x) => x.key === 'lookaheadWeeks');
    if (!p) continue;
    assert.equal(p.min, 1, `${s.id} cannot be set below ${p.min} weeks`);
  }
});

test('a one-week plan is a legal setting and still returns a pick', () => {
  const games = [game({ home: 'NYG', away: 'DAL' }), game({ home: 'KC', away: 'DEN' })];
  const ctx = makeContext({ season: 2026, week: 1, games, scheduleGames: games });
  for (const s of listStrategies()) {
    if (!(s.params ?? []).some((p) => p.key === 'lookaheadWeeks')) continue;
    const result = run(s.id, ctx, { lookaheadWeeks: 1 });
    assert.ok(result.picks.some((p) => p.candidate), `${s.id} returned no pick at lookahead 1`);
  }
});

test('the spread curve round-trips, and certainty does not become infinite', () => {
  for (const share of [0.5, 0.6, 0.75, 0.9, 0.99]) {
    assert.ok(Math.abs(homeShareFromSpreadLine(spreadLineFromHomeShare(share)) - share) < 1e-12);
  }
  assert.ok(Number.isFinite(spreadLineFromHomeShare(0)));
  assert.ok(Number.isFinite(spreadLineFromHomeShare(1)));
});
