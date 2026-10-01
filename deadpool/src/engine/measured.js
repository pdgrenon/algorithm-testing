/**
 * What the backtest actually found, as one table.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * The settings screen listed six strategies as equals, each with an equally
 * confident blurb, and said nothing about the fact that they had been raced
 * against each other over thousands of seasons and come out a long way apart.
 * Three of them put both entries on the same team, which measured *worse than
 * not playing* -- and the app's only acknowledgement of that was a warning
 * after the fact, on the week it happened.
 *
 * The repository is called algorithm-testing. Not publishing the test results
 * on the one screen where somebody chooses between the algorithms was the
 * gap.
 *
 * ── What the number is ──────────────────────────────────────────────────
 *
 * `xFair` is a multiple of a **fair share of the pot**, not a survival rate.
 * A survivor pool pays whoever gets deepest, split among however many reach
 * that week, so lasting longer than the field is worth money and lasting
 * longer in a week everybody else also survived is worth nothing. 1.00 is
 * what an entry picking at random from the field's own distribution takes
 * home; 1.61 is 61% more than that; 0.86 is losing money.
 *
 * A multiple rather than a rank, because two of these are a statistical dead
 * heat and calling one of them "1st" would invent a difference the
 * measurement explicitly did not find.
 *
 * ── Why these numbers are trusted, and how far ──────────────────────────
 *
 * Not far, and the history is the reason. **Three** strategies have now been
 * falsified by larger samples after looking like winners. `potshare` measured
 * 3.02x at n=400 with t=2.99 and came back t=1.01 at n=2000. `ps-h4` was the
 * best of eight at n=800 and finished behind `distinct` at n=2500. And
 * `leverage` led `distinct` by t=1.60 at n=2500, 0.75 at 5000, and at 10000
 * the sign had flipped. The metric pays nobody in about 96% of seasons, so its
 * distribution is heavy-tailed and a t of 3 at n=400 is a hypothesis rather
 * than a result.
 *
 * The same arithmetic runs the other way and is the reason this table is now
 * at n=10000 rather than 2500. Every number in it moved -- `distinct` 1.72 to
 * 1.91, `ranked` 0.74 to 0.88 -- and two comparisons changed category:
 * `distinct` over `joint` went 0.73 to 2.43, and over `sequential` 0.83 to
 * 2.32. Those grew roughly as the square root of the sample, which is what a
 * real difference does. A table whose rows came from different sample sizes
 * could not have shown either thing, which is why re-running one strategy is
 * never enough.
 *
 * ── Two metrics, because one of them is mostly zeroes ───────────────────
 *
 * Everything above is pot share, which is what the pool pays and is also the
 * worst-behaved number this harness produces. It is zero in about 96% of
 * seasons, so most *pairs* of strategies tie in most seasons: `distinct`
 * against `joint` had 376 seasons ahead and 298 behind out of 10000, and the
 * other 9326 were ties. A t of 2.43 there rests on 674 seasons, not 10000.
 *
 * That, and not the sample size, is why larger runs kept not settling it. The
 * fix was not more seasons -- it was to also pair on **weeks survived**, which
 * is a real number every season instead of a zero in nineteen of twenty. Its
 * informative counts run from 1472 to 6923 where pot share's run from 333 to
 * 1701, and it was already being computed: the `deepestWeek` column here is
 * its grand mean, reduced per season and then thrown away before anything
 * could pair it.
 *
 * The two agree on direction everywhere they both see anything, which is the
 * strongest thing in this file. `distinct` over `joint` is 2.43 on money and
 * 3.36 on depth; over `sequential`, 2.32 and 3.13; `joint` against
 * `sequential` is a dead heat on both, 0.49 and 0.30. Two metrics with
 * different noise pointing the same way is better evidence than either at
 * twice the sample.
 *
 * Where they *disagree* is the interesting part, and there is exactly one such
 * place: `distinct` over `leverage` is 0.30 on money and 3.84 on depth. Read
 * that as the sentence it is -- `leverage` survived measurably less long and
 * still took the same money -- which is precisely the trade it was built to
 * make. The differentiation is real and it pays for the survival it costs,
 * exactly, and no more.
 *
 * ── And the field it was all measured against ───────────────────────────
 *
 * Everything above assumes a field at `CASUAL_TAU` = 0.35, which is where
 * every published run has been and, until `--field-tau` existed, the only
 * place any of them could be. It is also the *least* concentrated point on
 * the ladder (SHARP 0.15, AVERAGE 0.25, CASUAL 0.35), which made it the wrong
 * place to have falsified a strategy whose whole premise is avoiding a crowd.
 *
 * So the chalky endpoint was run: 10000 seasons at tau = 0.15. Two controls
 * passed first -- the field-blind depth row came out bit-identical (`distinct`
 * over `joint`, 0.098 / 0.029 / t = 3.36 / 1406 vs 1233, exactly as at 0.35),
 * and the opponents' best depth fell from 15.60 to 13.76 as a chalkier field
 * spends its inventory faster and dies earlier.
 *
 * Everyone earns more against a field that kills itself: `distinct` 3.62x
 * fair, `leverage` 3.64x, `joint` 2.99x. What matters is what did and did not
 * change underneath that.
 *
 *   `distinct` over `joint`, money    2.43 -> 5.67  ordering holds, gap grows
 *   `distinct` over `joint`, depth    3.36 -> 3.36  the control
 *   `leverage` vs `distinct`, money   0.30 -> 0.30  unchanged to two decimals
 *   `distinct` over `leverage`, depth 3.84 -> 4.41  costs *more* survival here
 *
 * `leverage` is not rescued by the field it was designed for. Given the
 * chalkiest pool on the ladder -- the best case its own premise can ask for --
 * it is the same break-even trade to two decimal places, and it gives up more
 * survival to make it. That is the falsification finished rather than merely
 * asserted.
 *
 * ── At the pool's real size ─────────────────────────────────────────────
 *
 * Everything above was measured in a 250-entry pool, a size the two-entry
 * path hardcoded until the pool's own sheet showed 378. The table below is
 * one run at `--pool-size 378`, everything else unchanged, and the control
 * passed first: field-blind strategies cannot see the pool, and their depth
 * row is bit-identical to the same code run at 250 (`distinct` over `joint`,
 * 0.098 / 0.029 / t = 3.34 / 1406 vs 1234). That is one season off the 250
 * table's 1233 -- not the pool size, but engine fixes merged after that table
 * was published, which the same check at 250 on today's code reproduces.
 *
 *   `distinct`                    1.91 -> 1.91  unchanged
 *   `leverage` vs `distinct`, $   0.30 -> 0.33  still a dead heat; the sign
 *                                               flipped, 212 seasons vs 210
 *   `distinct` > `leverage`, depth 3.84 -> 3.69  still survives less
 *   top pair > `joint`/`sequential` 2.15-2.43 -> 2.21-2.43  holds
 *   colliding strategies          1.04 / 1.01 / 0.88 -> 1.07 / 1.05 / 0.92
 *
 * So the answer does not change with the pool. `leverage` now has the higher
 * mean by 0.03, which is the same kind of nothing it was when `distinct` led
 * by that much; the depth table still says it survives measurably less long
 * to take the same money. A bigger pool is more people to split with, and
 * the field's best entry goes deeper (15.60 -> 16.15), but in proportion to
 * a fair share it moves almost nothing.
 *
 * So: these are the largest samples run, they are paired (every strategy sees
 * identical seasons against identical fields, and the statistic is the mean
 * per-season difference), and they are still simulated seasons rather than
 * played ones. The app says the number and says where it came from. It does
 * not say it is settled.
 *
 * ── Keeping it honest ───────────────────────────────────────────────────
 *
 * `null` is a legal and expected value: it means nobody has measured this
 * one, and it is a real state rather than a gap to be filled with a plausible
 * guess. What a strategy may *not* be is absent from this table altogether:
 * test/engine.test.js asserts both directions -- every registered strategy has
 * a row here, and every row here names a registered strategy -- so a new one
 * cannot quietly arrive unmeasured and unremarked, and a deleted one cannot
 * leave its number behind.
 *
 * That guard is in the suite rather than in `register()`, and deliberately:
 * index.js validates the *shape* of a plug-in, which is a property of the
 * plug-in, and a strategy that fails to load takes the app down with it. Being
 * unrated is a property of the repository, and the right place to be loud
 * about it is CI.
 */

/** The run these numbers came out of, so they can be reproduced. */
export const RUN = Object.freeze({
  seasons: 10000,
  entries: 2,
  // The pool's real size, off its own sheet. Every run before this one was
  // at 250; see "At the pool's real size" above.
  poolSize: 378,
  fieldsPerSeason: 25,
  // Synthetic rather than the real seasons on record, and that is the whole
  // reason there is enough sample to say anything: there are about 25 seasons
  // of results and the metric is silent in most of them. The generator is
  // fitted to the real distribution of favourites and best-in-week prices,
  // and carries mean-reverting strength drift so a team's price moves across
  // a season the way a real one does. scripts/synth.py.
  command: 'python3 scripts/backtest.py --entries 2 --synthetic 10000 --fields 25 --pool-size 378 --jobs 4 --pairs ranked value twice sequential joint distinct leverage lev-g0',
  // Prints two paired tables, on pot share and on weeks survived. The 250 run
  // carried `--pot-share`, which the two-entry path never read and the
  // harness now warns about, so it is gone from the command rather than
  // implied to have mattered. Took 115 minutes on four cores.
  metrics: Object.freeze(['pot share', 'weeks survived']),
});

/**
 * Strategy id to what the backtest found. `null` means not measured.
 *
 * FILLED FROM THE RUN ABOVE -- do not edit a number here without re-running.
 */
export const MEASURED = Object.freeze({
  // `pair` is the name this was raced under in scripts/backtest.py. The two
  // files are joined by nothing but that string, so tests/test_measured_table.py
  // reads these back out and refuses one that no longer exists -- a renamed
  // comparison would otherwise leave the app printing an old number, which
  // still looks like evidence and is now evidence of nothing.
  //
  // Read `pair` rather than matching names by eye. The two vocabularies do not
  // agree and have collided badly before: `twice` in the backtest is the
  // `sequence` strategy, near the bottom, and it was briefly reported against
  // a display name containing the word "twice" that belonged to `distinct`,
  // at the top -- the ranking inverted, best for worst.
  //
  // A note may name another strategy as `{id}`, resolved to whatever that
  // strategy is currently called. Writing the name out would be the same fact
  // in two files, which is how this drifts: rename a strategy and every note
  // quoting it silently describes something that no longer exists.
  //
  // `samePick` is how often the two entries landed on one team. It is a count
  // rather than an estimate, and it is what the warning is drawn from: 1.91
  // against 1.04 is a measurement with a standard error, and 0% against 100%
  // is a fact.
  //
  // ── `note` is picker copy, not the record ──────────────────────────────
  //
  // It renders on the strategy picker, which is a phone screen somebody is
  // reading twenty minutes before kickoff while deciding. It is not the place
  // for t-statistics, sample sizes or falsification history.
  //
  // These notes reached 2,910 characters across seven strategies -- `distinct`
  // and `leverage` over 700 each, opening with "t = 2.43 against Best pair,
  // chosen together, 2.32 against One safe pick" -- because every time a
  // measurement landed, the finding was appended here as well as to the
  // docblock. Each addition was true and defensible on its own and the
  // aggregate was unreadable, which is the usual way a screen degrades.
  //
  // So: one or two short sentences, naming only what changes the choice --
  // is it good, what is the catch, does it need anything. The number is
  // already in the pill beside it and the collision warning is already tinted,
  // so the note should not repeat either. Everything else -- how it was
  // measured, at what sample, what it beat and by how much -- belongs in this
  // file's docblock above, in README.md, and in the strategy's own module.
  // Those are read by people choosing to read them.
  //
  // MAX_NOTE_CHARS is asserted in test/picker.test.js.
  distinct: {
    xFair: 1.91,
    samePick: 0,
    deepestWeek: 6.52,
    pair: 'distinct',
    note: 'Survives longest of any strategy, and level with {leverage} on money. The app default.',
  },
  leverage: {
    xFair: 1.94,
    samePick: 0,
    deepestWeek: 6.47,
    pair: 'leverage',
    note: 'Measured no better than {distinct}, and it needs the pool sheet. Without one it picks identically.',
  },
  joint: {
    xFair: 1.68,
    samePick: 0,
    deepestWeek: 6.42,
    pair: 'joint',
    note: 'A little behind {distinct}. Level with {sequential}.',
  },
  sequential: {
    xFair: 1.63,
    samePick: 0,
    deepestWeek: 6.42,
    pair: 'sequential',
    note: 'Level with {joint}, a little behind {distinct}. The simpler of the two searches.',
  },
  sequence: {
    xFair: 1.07,
    samePick: 1,
    deepestWeek: 4.53,
    pair: 'twice',
    note: 'Puts both entries on the same team every week — you stake two and carry the risk of one.',
  },
  value: {
    xFair: 1.05,
    samePick: 1,
    deepestWeek: 4.47,
    pair: 'value',
    note: 'Puts both entries on the same team every week. A one-step version of {sequence}.',
  },
  ranked: {
    xFair: 0.92,
    samePick: 1,
    deepestWeek: 4.41,
    pair: 'ranked',
    note: 'The control: best team available, no planning ahead. Both entries land together.',
  },
});

/**
 * What the table above actually says, which is not "use this one".
 *
 * The dominant line is still whether the two entries may land on the same
 * team. At the pool's real size, leverage/distinct/joint/sequential come out
 * 1.94, 1.91, 1.68, 1.63 at 0% collisions; twice/value/ranked come out 1.07,
 * 1.05, 0.92 at 100%. Every crossing between those blocks separates, at t from
 * 4.54 to 8.91 -- worth about two extra weeks of survival and roughly 1.6 to 2
 * times the money back. Nothing else in this table is close to that size.
 *
 * The paragraphs below were written at 250 entries; their numbers are that
 * run's, and the 378 run reproduces every conclusion in them.
 *
 * What is new at n=10000 is that the top block is **no longer one group**.
 * `distinct` and `leverage` (1.91, 1.89, t = 0.30 apart) now sit measurably
 * above `joint` and `sequential` (1.70, 1.66, t = 0.49 apart), at t = 2.15 to
 * 2.43 across the four crossings. At n=2500 those crossings were 0.73 and
 * 0.83 and the honest reading was a coin toss. They grew with the sample.
 *
 * Read that as a hypothesis, not a result -- this file's bar is that t over 2
 * stays a hypothesis until it holds at several times the sample, and it has
 * been wrong three times about numbers that looked better than this one. But
 * the *direction* now has both things that separate a real effect from a lucky
 * one. It grew with the sample, 0.73 to 2.43 as n quadrupled. And it holds on
 * a second metric with different noise and ten times the informative seasons,
 * at t = 3.36. Neither of those alone would move it out of hypothesis; the two
 * together are why it is no longer written as a coin toss.
 *
 * And the bottom block has moved up. `value` and `twice` are now at or just
 * above a fair share rather than below it, and `ranked` is 1.8 standard
 * errors under -- close, and no longer the clean "measurably below fair" that
 * a quarter of this sample supported.
 *
 * That is why `samePick` drives the warning rather than `xFair`, and this
 * sample makes the point better than the last one did: at 1.04 and 1.01,
 * `twice` and `value` now sit *above* a fair share, so tinting them on the
 * multiple would mark them safe. What is actually wrong with them is not the
 * money they return against a random entry, it is that they spend two entries
 * to get one entry's exposure -- and "both entries on one team, every week" is
 * a fact rather than a measurement with an error bar.
 */
export const COLLIDES = (id) => MEASURED[id]?.samePick >= 0.99;

/**
 * The budget for a picker note, in characters.
 *
 * Not a style preference -- a guard on a screen that degraded once. See the
 * comment above MEASURED. Roughly two short sentences at the widths this app
 * renders at; anything longer wants to be in a docblock instead.
 */
export const MAX_NOTE_CHARS = 140;

/** One sentence naming the sample, for the top of the picker. */
export const measurementSummary = () =>
  `Rated over ${RUN.seasons.toLocaleString()} simulated seasons, two entries in a `
  + `${RUN.poolSize}-entry pool. The score is a multiple of a fair share of the pot: `
  + `1.00 is what picking with the field takes home.`;
