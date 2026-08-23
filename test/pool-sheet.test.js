/**
 * Reading the pool's pick sheet, in the browser engine.
 *
 * Mirrors tests/test_pool_sheet.py case for case. The Python is the
 * definition and this is the port, so where they disagree the Python is right
 * -- and normalizeTeam was checked against every one of the 491 inputs the
 * Python lookup knows before this file was written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AmbiguousTeam,
  UnknownTeam,
  loadPoolSheet,
  normalizeTeam,
  parseCsv,
  popularity,
  usedTeamsByEntry,
} from '../deadpool/src/engine/pool-sheet.js';

const SHEET = `Team Name,Elimination Status,Week 1 Pick,Week 2 Pick,Week 3 Pick
Gridiron Gang,Alive,KC,Bills,San Francisco
Ship of Theseus,Out - Week 3,Chiefs,SF,Jets
Nacho Average Team,Alive,Baltimore Ravens,DET,GB
Fourth and Long,ELIMINATED,Green Bay,BUF,
`;

const byName = (sheet) => Object.fromEntries(sheet.entries.map((e) => [e.entryName, e]));

test('the same team written several ways', () => {
  for (const [raw, want] of [
    ['KC', 'KC'], ['Chiefs', 'KC'], ['Kansas City', 'KC'], ['Kansas City Chiefs', 'KC'],
    ['  chiefs  ', 'KC'], ['49ers', 'SF'], ['Niners', 'SF'], ['San Francisco', 'SF'],
  ]) assert.equal(normalizeTeam(raw), want, raw);
});

test('the abbreviations this codebase gets wrong elsewhere', () => {
  // WSH not WAS, JAX not JAC, LV not LVR, LAR not LA -- the four the parity
  // suite already guards on the engine side. A sheet written by a person will
  // use the other spelling, and it has to land.
  for (const [raw, want] of [
    ['WAS', 'WSH'], ['Washington', 'WSH'], ['Commanders', 'WSH'],
    ['JAC', 'JAX'], ['LVR', 'LV'], ['Oakland', 'LV'],
    ['San Diego', 'LAC'], ['St. Louis', 'LAR'],
  ]) assert.equal(normalizeTeam(raw), want, raw);
});

test('a name that means two teams is refused, not guessed', () => {
  // Resolving "LA" to whichever came first in a map would put an opponent on
  // a team they never picked, which corrupts their inventory and every
  // forecast built on it, and nothing about the output looks wrong.
  for (const raw of ['LA', 'Los Angeles', 'NY', 'New York']) {
    assert.throws(() => normalizeTeam(raw), AmbiguousTeam, raw);
  }
});

test('something that is not a team is refused', () => {
  assert.throws(() => normalizeTeam('Sharks'), UnknownTeam);
});

test('a blank cell is a missing pick, not an error', () => {
  assert.equal(normalizeTeam(''), null);
  assert.equal(normalizeTeam('   '), null);
});

test('it reads the expected shape', () => {
  const sheet = loadPoolSheet(SHEET);
  assert.deepEqual(sheet.entries.map((e) => e.entryName), [
    'Gridiron Gang', 'Ship of Theseus', 'Nacho Average Team', 'Fourth and Long',
  ]);
  assert.deepEqual(sheet.weeks, [1, 2, 3]);
});

test('the entry-name column is not an NFL team', () => {
  // The heading says "Team Name" and means the person's entry. Reading it as a
  // team would give a field of 250 franchises that do not exist.
  const sheet = loadPoolSheet(SHEET);
  assert.equal(sheet.entries[0].entryName, 'Gridiron Gang');
  assert.equal(sheet.entries[0].picks[1], 'KC');
});

test('mixed name formats in one column all resolve', () => {
  const entries = byName(loadPoolSheet(SHEET));
  assert.deepEqual(entries['Gridiron Gang'].picks, { 1: 'KC', 2: 'BUF', 3: 'SF' });
  assert.deepEqual(entries['Nacho Average Team'].picks, { 1: 'BAL', 2: 'DET', 3: 'GB' });
});

test('unknown status text means out', () => {
  // A sheet says "Out - Week 3" in more ways than it says "Alive", so anything
  // unrecognised reads as eliminated. Treating an unknown status as alive
  // inflates the field, which inflates the denominator the pot is divided by.
  const entries = byName(loadPoolSheet(SHEET));
  assert.equal(entries['Gridiron Gang'].alive, true);
  assert.equal(entries['Ship of Theseus'].alive, false);
  assert.equal(entries['Fourth and Long'].alive, false);
});

test('a blank week is simply absent', () => {
  const entries = byName(loadPoolSheet(SHEET));
  assert.equal(3 in entries['Fourth and Long'].picks, false);
});

test('the inventory table is what comes out', () => {
  const inventories = usedTeamsByEntry(loadPoolSheet(SHEET));
  assert.deepEqual([...inventories['Gridiron Gang']].sort(), ['BUF', 'KC', 'SF']);
});

test('a column is added each week', () => {
  // Nothing may hardcode eighteen. A four-week sheet in week four is correct,
  // and week five's column appears without warning.
  const four = SHEET
    .replace('Week 3 Pick', 'Week 3 Pick,Week 4 Pick')
    .replace(',San Francisco', ',San Francisco,MIN');
  const sheet = loadPoolSheet(four);
  assert.ok(sheet.weeks.includes(4));
  assert.equal(sheet.entries[0].picks[4], 'MIN');
});

test('headings it should still recognise', () => {
  const body = SHEET.split('\n').slice(1).join('\n');
  for (const headers of [
    'Entry,Status,Week 1 Pick,Week 2 Pick,Week 3 Pick',
    'Team Name,Elimination Status,Wk 1,Wk 2,Wk 3',
    'Player,Alive,W1,W2,W3',
    'Team Name,Status,1,2,3',
  ]) {
    const sheet = loadPoolSheet(`${headers}\n${body}`);
    assert.deepEqual(sheet.weeks, [1, 2, 3], headers);
    assert.equal(sheet.entries.length, 4, headers);
  }
});

test('one bad cell does not cost the other rows', () => {
  const broken = SHEET.replace('Nacho Average Team,Alive,Baltimore Ravens', 'Nacho Average Team,Alive,Sharks');
  const sheet = loadPoolSheet(broken);
  assert.equal(sheet.entries.length, 4, 'one typo in row 180 must not lose the other 249');
  assert.ok(sheet.problems.some((p) => p.includes('Sharks')));
});

test('strict mode throws for a test to catch', () => {
  const broken = SHEET.replace('Baltimore Ravens', 'Sharks');
  assert.throws(() => loadPoolSheet(broken, { strict: true }), UnknownTeam);
});

test('a team spent twice is reported', () => {
  // Readable, but cannot be true. Worth surfacing because the engine is about
  // to treat this as ground truth about 250 people.
  const doubled = SHEET.replace(
    'Gridiron Gang,Alive,KC,Bills,San Francisco',
    'Gridiron Gang,Alive,KC,Bills,Chiefs',
  );
  assert.ok(loadPoolSheet(doubled).problems.some((p) => p.includes('only be spent once')));
});

test('an empty sheet says so rather than returning nothing', () => {
  const sheet = loadPoolSheet('');
  assert.ok(sheet.problems.length);
  assert.equal(sheet.entries.length, 0);
});

test('a sheet with no week columns says so', () => {
  assert.ok(loadPoolSheet('Team Name,Status\nA,Alive\n').problems.some((p) => p.includes('no week columns')));
});

test('observed popularity is what the field actually did', () => {
  const week1 = popularity(loadPoolSheet(SHEET), 1);
  assert.equal(week1.KC, 0.5, 'two of four took Kansas City');
  assert.equal(week1.BAL, 0.25);
  assert.equal(week1.GB, 0.25);
  assert.equal(Object.values(week1).reduce((a, b) => a + b, 0), 1);
});

test('a week nobody has played is empty rather than wrong', () => {
  assert.deepEqual(popularity(loadPoolSheet(SHEET), 9), {});
});

test('the CSV reader handles what a person actually types', () => {
  // No dependency to lean on, so the reader is written out -- and an entry
  // called `O'Brien, "The Streak"` is a real thing somebody names an entry.
  const rows = parseCsv('a,"b,c","say ""hi""",d\n1,2,3,4\n');
  assert.deepEqual(rows[0], ['a', 'b,c', 'say "hi"', 'd']);
  assert.deepEqual(rows[1], ['1', '2', '3', '4']);
});

test('a byte-order mark does not eat the first heading', () => {
  // Google prefixes exported CSV with one, and a BOM stuck to "Team Name"
  // makes the entry column unrecognisable -- which reads as a sheet with no
  // entries rather than as an encoding problem.
  const sheet = loadPoolSheet(`﻿${SHEET}`);
  assert.equal(sheet.entries.length, 4);
  assert.deepEqual(sheet.weeks, [1, 2, 3]);
});
