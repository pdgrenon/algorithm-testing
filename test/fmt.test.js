/**
 * The number formatter, against Python's own output.
 *
 * `test/fmt-cases.json` is written by scripts/gen-golden.py, so the
 * expectations here are what Python actually printed rather than what anybody
 * remembers about how Python rounds. Every value in it sits on or near a
 * rounding boundary, because that is the only place the two languages differ:
 * Python rounds a half to even, JavaScript's toFixed rounds it away from zero.
 *
 * This is the primary guard on fmt.js. The parity suite covers it end to end
 * as well — see the rounding-edges fixture — but that took a deliberate
 * addition to arrange, and for a while the whole suite stayed green with the
 * half-even rounding removed. A direct test is what stops that recurring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { f0, f1, f3, pct0, fixed } from '../deadpool/src/engine/fmt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(join(HERE, 'fmt-cases.json'), 'utf8'));

const FNS = { f0, f1, f3, pct0 };

for (const [name, fn] of Object.entries(FNS)) {
  test(`${name} matches Python on every boundary value`, () => {
    const cases = CASES[name];
    assert.ok(Object.keys(cases).length > 0, `no cases for ${name}`);
    for (const [input, expected] of Object.entries(cases)) {
      const value = Number(input);
      assert.equal(fn(value), expected, `${name}(${input}) — Python says ${expected}`);
    }
  });
}

test('toFixed alone would not do — the difference is real, not theoretical', () => {
  // If this ever stops failing, the two languages have converged and fmt.js
  // could be simplified. Until then it is the reason the file exists.
  const boundaries = Object.entries(CASES.f1).filter(([v, want]) => Number(v).toFixed(1) !== want);
  assert.ok(
    boundaries.length > 0,
    'no case in fmt-cases.json distinguishes half-even from toFixed, so this suite proves nothing',
  );
  for (const [v, want] of boundaries) assert.equal(f1(Number(v)), want);
});

test('negative zero keeps its sign, as Python does', () => {
  assert.equal(f1(-0.04), '-0.0');
});

test('fixed() is stable for non-finite input rather than throwing', () => {
  // Reasoning strings are built from values that can be null upstream; the
  // guards are elsewhere, but a formatter that throws would turn a missing
  // number into a blank screen.
  assert.equal(fixed(NaN, 1), 'NaN');
  assert.equal(fixed(Infinity, 1), 'Infinity');
});
