/**
 * The settings picker publishes what the backtest found.
 *
 * The repository is called algorithm-testing and, until this, the one screen
 * where somebody chooses between the algorithms listed six of them as equals
 * -- each with a confident blurb, none with a number. Three of the six put
 * both entries on the same team every week, which the simulation says loses
 * money against the field, and the app's only acknowledgement was a warning
 * after the fact on the week it happened.
 *
 * Nothing in this suite draws a page, so this drives the real render into a
 * fake element and reads the markup back. It is a much weaker check than
 * looking at it, and it catches the class of thing that is invisible in a
 * diff: a rating quietly not rendered, an ordering that puts the worst first,
 * or a score printed for a strategy nobody measured.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { render } from '../deadpool/src/views/settings.js';
import { listStrategies, getStrategy, defaultParams, DEFAULT_STRATEGY_ID } from '../deadpool/src/engine/index.js';
import { MEASURED, COLLIDES } from '../deadpool/src/engine/measured.js';

/** The one thing a view needs: something with an innerHTML to write to. */
function draw() {
  const root = { innerHTML: '' };
  const active = getStrategy(DEFAULT_STRATEGY_ID);
  render(root, {
    state: { entries: [{ id: 'Entry A' }, { id: 'Entry B' }], blocked: null },
    strategies: listStrategies(),
    activeStrategy: active,
    params: defaultParams(active),
    comparison: null,
    storage: { used: 0, quota: 0 },
    alarm: null,
  });
  return root.innerHTML;
}

/**
 * A strategy's score, or null.
 *
 * Three states, not two: a rating, an explicit `null` entry meaning nobody
 * measured this one, and a strategy absent from the table altogether. The
 * view collapses the last two into "not measured" and this has to agree with
 * it, or the test passes on markup nobody would accept.
 */
const scoreOf = (id) => {
  const m = MEASURED[id];
  return m && Number.isFinite(m.xFair) ? m.xFair : null;
};

/** The strategy ids in the order the picker lists them. */
function order(html) {
  return [...html.matchAll(/data-act="strategy" data-id="([^"]+)"/g)].map((m) => m[1]);
}

test('every strategy in the picker carries a rating or says it has none', () => {
  const html = draw();
  const ids = order(html);
  assert.equal(ids.length, listStrategies().length, 'every registered strategy is offered');

  for (const id of ids) {
    const x = scoreOf(id);
    if (x !== null) {
      assert.ok(html.includes(`${x.toFixed(2)}× fair`), `${id} does not print its ${x} rating`);
    }
  }
  const unrated = ids.filter((id) => scoreOf(id) === null).length;
  const saidSo = [...html.matchAll(/not measured/g)].length;
  assert.equal(saidSo, unrated, 'an unmeasured strategy has to say so rather than show nothing');
});

test('the best-measured is listed first and the worst last', () => {
  // Import order is not an opinion about quality, and it read like one.
  const ids = order(draw()).filter((id) => scoreOf(id) !== null);
  const scores = ids.map(scoreOf);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a),
    `the picker is not ordered by what was measured: ${ids.join(' > ')}`);
});

test('a strategy that puts both entries on one team is marked, not just numbered', () => {
  // The tint is on the certain fact rather than the estimate, and that is the
  // finding rather than a presentation choice. 0.98 is not distinguishable
  // from a fair share -- its standard error spans it -- so tinting it as a
  // loser would claim something the run did not find. "Both entries on the
  // same team, every week of 2,500 seasons" is not an estimate at all, and it
  // is what actually separates the six into two groups.
  const html = draw();
  const colliders = Object.keys(MEASURED).filter((id) => COLLIDES(id));
  assert.ok(colliders.length, 'this test is vacuous if nothing collides');
  assert.equal([...html.matchAll(/pill pill--bad/g)].length, colliders.length);
  // Counted by the element rather than by the phrase: two of the notes say
  // the same thing in prose, and matching on the words counted those too.
  assert.equal([...html.matchAll(/choice__measured--warn/g)].length, colliders.length,
    'and it has to say so in words, not only in a colour');
});

test('the two groups are what the ordering actually shows', () => {
  // Nothing inside either group separated -- 0.73, 0.83, 0.29 at the top and
  // 0.44, 1.45, 1.37 at the bottom -- while all nine crossings between them
  // did, at t from 2.92 to 5.36. So the list must not interleave them: a
  // colliding strategy above a non-colliding one would put a coin-toss
  // difference above the one real finding in the run.
  const ids = order(draw()).filter((id) => scoreOf(id) !== null);
  const firstCollider = ids.findIndex((id) => COLLIDES(id));
  assert.ok(firstCollider > 0, 'the top of the list must not collide');
  assert.ok(ids.slice(firstCollider).every((id) => COLLIDES(id)),
    `a non-colliding strategy is listed below a colliding one: ${ids.join(' > ')}`);
});

test('the sample the ratings come from is stated on the screen', () => {
  // A rating with no sample behind it is the confident sentence this project
  // distrusts everywhere else -- and two strategies here were already
  // falsified by going from 400 seasons to 2,000.
  const html = draw();
  assert.match(html, /simulated seasons/);
  assert.match(html, /fair share of the pot/, 'and what the number actually means');
});

test('nothing in the ratings escapes into the markup unescaped', () => {
  // Notes are prose written by hand in a JS file and injected into a template
  // string. esc() is what stands between that and a broken page.
  for (const m of Object.values(MEASURED)) {
    if (!m) continue;
    assert.ok(!/[<>]/.test(m.note), 'a note carrying markup would need escaping to be verified, not assumed');
  }
});
