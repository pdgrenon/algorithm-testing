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
import { esc } from '../deadpool/src/ui/dom.js';
import { MEASURED, COLLIDES, MAX_NOTE_CHARS } from '../deadpool/src/engine/measured.js';

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
  // The tint is on the certain fact rather than the estimate, and the larger
  // sample made that choice look better rather than worse. At 2,500 seasons
  // the argument was that 0.98 could not be told from a fair share, so tinting
  // it as a loser would claim something the run did not find. At 10,000 the
  // colliding strategies come out at 1.04, 1.01 and 0.88 -- two of them *above*
  // fair -- so tinting on the multiple would now mark them safe. What is wrong
  // with them was never the money against a random entry; it is that they
  // spend two entries for one entry's exposure. "Both entries on the same
  // team, every week of 10,000 seasons" is not an estimate at all.
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
  // The split between colliding and non-colliding is still the dominant line
  // by a wide margin: every crossing between the blocks separates, at t from
  // 6.02 to 10.95 on money at 10,000 seasons, where nothing inside the bottom
  // block does. So the list must not interleave them -- a colliding strategy
  // above a non-colliding one would put the smaller question above the larger
  // one. (The top block is no longer a single group at this sample, but that
  // is an ordering *within* it and does not change this rule.)
  const ids = order(draw()).filter((id) => scoreOf(id) !== null);
  const firstCollider = ids.findIndex((id) => COLLIDES(id));
  assert.ok(firstCollider > 0, 'the top of the list must not collide');
  assert.ok(ids.slice(firstCollider).every((id) => COLLIDES(id)),
    `a non-colliding strategy is listed below a colliding one: ${ids.join(' > ')}`);
});

test('the sample the ratings come from is stated on the screen', () => {
  // A rating with no sample behind it is the confident sentence this project
  // distrusts everywhere else -- and three strategies here have now been
  // falsified by a larger sample: `potshare` from 400 to 2,000, `ps-h4` from
  // 800 to 2,500, `leverage` from 2,500 to 10,000.
  const html = draw();
  assert.match(html, /simulated seasons/);
  assert.match(html, /fair share of the pot/, 'and what the number actually means');
});

test('a picker note stays short enough to read while choosing', () => {
  // The picker is a phone screen somebody reads twenty minutes before kickoff.
  // These notes reached 2,910 characters across seven strategies -- two of
  // them over 700, opening with "t = 2.43 against Best pair, chosen together"
  // -- because each new measurement got appended here as well as to the
  // docblock. Every addition was individually true, and the aggregate was a
  // wall of statistics on the one screen that has to be skimmable.
  //
  // Asserted rather than merely fixed, because the pressure that produced it
  // is permanent: there will always be another finding worth writing down, and
  // this is never the place for it.
  for (const [id, m] of Object.entries(MEASURED)) {
    if (!m?.note) continue;
    assert.ok(m.note.length <= MAX_NOTE_CHARS,
      `${id}'s picker note is ${m.note.length} chars, over the ${MAX_NOTE_CHARS} budget — `
      + 'the reasoning belongs in the measured.js docblock, not on the picker');
  }
});

test('a picker note does not repeat what the screen already shows', () => {
  // The multiple is in the pill beside the note and the collision warning is
  // already tinted and spelled out, so a note that restates either spends the
  // reader's attention on something they have already been told. Statistical
  // notation is the other tell: a `t = ` on a picker is a docblock sentence
  // that escaped onto a consumer screen.
  for (const [id, m] of Object.entries(MEASURED)) {
    if (!m?.note) continue;
    assert.ok(!/\bt\s*=/.test(m.note),
      `${id}'s note quotes a t-statistic: ${m.note}`);
    assert.ok(!/\bx\s*fair|\d\.\d\d\s*(x|×)/i.test(m.note),
      `${id}'s note repeats the multiple already in its pill: ${m.note}`);
  }
});

test('nothing in the ratings escapes into the markup unescaped', () => {
  // Notes are prose written by hand in a JS file and injected into a template
  // string. esc() is what stands between that and a broken page.
  for (const m of Object.values(MEASURED)) {
    if (!m) continue;
    assert.ok(!/[<>]/.test(m.note), 'a note carrying markup would need escaping to be verified, not assumed');
  }
});

test('a note naming another strategy uses its current name, not a copy of it', () => {
  // The notes cross-reference each other, and writing the display name into
  // them would be the same fact in two files. That already went wrong once:
  // renaming the strategies left four notes quoting names that no longer
  // existed, and nothing said so.
  const html = draw();
  assert.ok(!/\{[a-z]+\}/.test(html), 'an unresolved {id} reached the page');

  const withRefs = Object.values(MEASURED).filter((m) => m && /\{\w+\}/.test(m.note));
  assert.ok(withRefs.length, 'this test is vacuous if no note references another strategy');
  for (const m of withRefs) {
    for (const [, id] of m.note.matchAll(/\{(\w+)\}/g)) {
      const target = getStrategy(id);
      assert.ok(target, `a note references '{${id}}', which is not a registered strategy`);
      assert.ok(html.includes(esc(target.name)), `${id}'s current name never reached the page`);
    }
  }
});

test('no blurb points at a position in the list', () => {
  // The list is ordered by the measurement, and the blurbs were written while
  // reading the source in registration order. Two of them came out pointing
  // the wrong way: "the same" referred to a strategy now listed below it, and
  // "the cleverness above it" was on the entry at the very top.
  for (const s of listStrategies()) {
    assert.doesNotMatch(s.blurb, /\b(above|below|the same,|previous|next) \b/i,
      `${s.id}'s blurb refers to a position, and the order is decided by the ratings`);
  }
});
