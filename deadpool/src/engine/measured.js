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
  poolSize: 250,
  fieldsPerSeason: 25,
  // Synthetic rather than the real seasons on record, and that is the whole
  // reason there is enough sample to say anything: there are about 25 seasons
  // of results and the metric is silent in most of them. The generator is
  // fitted to the real distribution of favourites and best-in-week prices,
  // and carries mean-reverting strength drift so a team's price moves across
  // a season the way a real one does. scripts/synth.py.
  command: 'python3 scripts/backtest.py --entries 2 --pot-share --synthetic 10000 --fields 25 --pairs ranked value twice sequential joint distinct leverage lev-g0',
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
  distinct: {
    xFair: 1.91,
    samePick: 0,
    deepestWeek: 6.52,
    pair: 'distinct',
    note: 'Top of the table and, at this sample, separated from the pair below it for the first time: '
      + 't = 2.43 against {joint}, 2.32 against {sequential}. At n = 2500 those were 0.73 and 0.83 — the '
      + 'gap grew with the sample, which is what a real difference does and what {leverage} conspicuously '
      + 'did not. Still a hypothesis by this file\'s own bar until it holds at several times the sample. '
      + 'The app default, though it was made the default on a different ground entirely: see engine/index.js.',
  },
  leverage: {
    xFair: 1.89,
    samePick: 0,
    deepestWeek: 6.47,
    pair: 'leverage',
    note: 'Falsified, and this is what that looks like. It led {distinct} by t = 1.60 at n = 2500, '
      + 'fell to 0.75 at 5000, and at 10000 the sign has flipped — {distinct} now leads it by 0.30. '
      + 'A real effect grows like the square root of the sample; this collapsed, exactly as `potshare` '
      + 'and `ps-h4` did before it. Reading the field is not worthless — it beats {joint} at t = 2.15, '
      + 'the same as {distinct} does — but it adds nothing over simply keeping the two entries apart.',
  },
  joint: {
    xFair: 1.70,
    samePick: 0,
    deepestWeek: 6.43,
    pair: 'joint',
    note: 'Level with {sequential} (t = 0.49) and now measurably behind {distinct} (2.43), which it was '
      + 'not at a quarter of this sample. It was the app default until the reason recorded for that turned '
      + 'out to be false: the note claimed a hedge putting the two entries on opposite sides of one game, '
      + 'and that is the single holding this strategy forbids — it skips those pairs so its independence '
      + 'assumption holds by construction. A real property, and a reason to keep it; never a reason to '
      + 'default to it.',
  },
  sequential: {
    xFair: 1.66,
    samePick: 0,
    deepestWeek: 6.42,
    pair: 'sequential',
    note: 'Level with {joint} (t = 0.49), which was not the expectation: it is the greedy form of the same '
      + 'search, and being greedy still costs nothing measurable. Behind {distinct} at t = 2.32.',
  },
  sequence: {
    xFair: 1.04,
    samePick: 1,
    deepestWeek: 4.53,
    pair: 'twice',
    note: 'Reached week 4.5 against 6.5 for the four above, on the same seasons, and loses to {distinct} at '
      + 't = 10.95 — the largest gap in this table by a wide margin. Two entries that die together are one '
      + 'entry that cost double. {distinct} is this same plan with the collision forbidden.',
  },
  value: {
    xFair: 1.01,
    samePick: 1,
    deepestWeek: 4.47,
    pair: 'value',
    note: 'Not separably different from the other two that collide (t = 1.90 over {ranked}). A one-step '
      + 'version of {sequence}, which searches the whole run instead.',
  },
  ranked: {
    xFair: 0.88,
    samePick: 1,
    deepestWeek: 4.41,
    pair: 'ranked',
    note: 'The control, and the only one still below a fair share — though at 1.8 standard errors under it '
      + 'that is no longer a separation either, where at a quarter of this sample it was. {sequence} prints '
      + 'this exact ranking with no schedule loaded, so it is that with the planning switched off.',
  },
});

/**
 * What the table above actually says, which is not "use this one".
 *
 * The dominant line is still whether the two entries may land on the same
 * team. distinct/leverage/joint/sequential come out 1.91, 1.89, 1.70, 1.66 at
 * 0% collisions; twice/value/ranked come out 1.04, 1.01, 0.88 at 100%. Every
 * crossing between those blocks separates, at t from 6.02 to 10.95 -- worth
 * about two extra weeks of survival and roughly double the money back. Nothing
 * else in this table is close to that size.
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
 * the *direction* is now supported by the thing that separates a real effect
 * from a lucky one, which is growth: 0.73 to 2.43 as n quadrupled.
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

/** One sentence naming the sample, for the top of the picker. */
export const measurementSummary = () =>
  `Rated over ${RUN.seasons.toLocaleString()} simulated seasons, two entries in a `
  + `${RUN.poolSize}-entry pool. The score is a multiple of a fair share of the pot: `
  + `1.00 is what picking with the field takes home.`;
