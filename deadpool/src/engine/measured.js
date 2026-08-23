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
 * Not far, and the history is the reason. Two strategies were **falsified by
 * larger samples** after looking like clear winners: `potshare` measured
 * 3.02x at n=400 with t=2.99, and came back t=1.01 -- indistinguishable from
 * the field -- at n=2000. `ps-h4` was the best of eight at n=800 and finished
 * behind `distinct` at n=2500. The metric pays nobody in about 96% of
 * seasons, so its distribution is heavy-tailed and a t of 3 at n=400 is a
 * hypothesis rather than a result.
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
  seasons: 2500,
  entries: 2,
  poolSize: 250,
  fieldsPerSeason: 25,
  // Synthetic rather than the real seasons on record, and that is the whole
  // reason there is enough sample to say anything: there are about 25 seasons
  // of results and the metric is silent in most of them. The generator is
  // fitted to the real distribution of favourites and best-in-week prices,
  // and carries mean-reverting strength drift so a team's price moves across
  // a season the way a real one does. scripts/synth.py.
  command: 'python3 scripts/backtest.py --entries 2 --pot-share --synthetic 2500',
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
  // rather than an estimate, and it is what the warning is drawn from: 1.72
  // against 0.98 is a measurement with a standard error, and 0% against 100%
  // is a fact.
  distinct: {
    xFair: 1.72,
    samePick: 0,
    deepestWeek: 6.55,
    pair: 'distinct',
    note: 'Top by the mean at every sample it has been run at — 1.72x here, 1.87x at n = 5000 — and not separably better than the two under it: t = 0.73 against {joint}, 0.83 against {sequential}. Anything under 2 is no difference at all, so this is the app default on the tie-breaks rather than on the measurement: it is never measurably worse, it is the simplest thing here, and it is the only one of the three that can end up with the two entries on opposite sides of one game.',
  },
  joint: {
    xFair: 1.62,
    samePick: 0,
    deepestWeek: 6.42,
    pair: 'joint',
    note: 'Level with the two beside it (t = 0.73 against {distinct}), and it was the app default until the reason recorded for that turned out to be false: it said a hedge against a field piled onto one team broke the tie, and putting the two entries on opposite sides of one game is the one holding this strategy forbids — it skips those pairs so its independence assumption holds by construction. That is a real property and a reason to keep it; it was not a reason to default to it.',
  },
  sequential: {
    xFair: 1.56,
    samePick: 0,
    deepestWeek: 6.37,
    pair: 'sequential',
    note: 'Level with {joint} (t = 0.29), which was not the expectation: it is the greedy form of the same search, and being greedy costs nothing measurable.',
  },
  sequence: {
    xFair: 0.98,
    samePick: 1,
    deepestWeek: 4.51,
    pair: 'twice',
    note: 'Reached week 4.5 against 6.6 for the three above, on the same seasons. Two entries that die together are one entry that cost double. {distinct} is this same plan with the collision forbidden.',
  },
  value: {
    xFair: 0.91,
    samePick: 1,
    deepestWeek: 4.39,
    pair: 'value',
    note: 'Not separably different from the other two that collide. A one-step version of {sequence}, which searches the whole run instead.',
  },
  leverage: {
    xFair: 1.87,
    samePick: 0,
    deepestWeek: 6.53,
    pair: 'leverage',
    note: 'The highest mean in the table, and NOT separated from {distinct}: '
      + 't = 1.60, 79 seasons to 66. A mean at the top of this metric has twice been '
      + 'a mirage here, so read it as a hypothesis. What is interesting is the shape '
      + 'rather than the size — it reaches the same week as {distinct} (6.53 against '
      + '6.55) and takes about 9% more of the pot for it, which is what avoiding the '
      + 'crowd should look like if it works at all. Needs a pool sheet; without one it '
      + 'is {distinct} exactly.',
  },
  ranked: {
    xFair: 0.74,
    samePick: 1,
    deepestWeek: 4.30,
    pair: 'ranked',
    note: 'The control, and the only one measurably below a fair share. {sequence} prints this exact ranking with no schedule loaded, so it is that with the planning switched off.',
  },
});

/**
 * What the table above actually says, which is not "use this one".
 *
 * They fall into two groups and nothing inside either group separates:
 * leverage/distinct/joint/sequential come out 1.87, 1.72, 1.62, 1.56, and
 * every pairwise t among them is under 2 -- 1.60 for the largest gap in the
 * group, leverage over distinct. twice/value/ranked come out 0.98, 0.91, 0.74
 * at 0.44, 1.45 and 1.37. Every crossing *between* the groups separates, at t
 * from 2.92 to 6.06.
 *
 * The line between the groups is not cleverness. It is whether the two entries
 * are allowed to land on the same team: 0% against 100%, worth about two extra
 * weeks of survival and roughly double the money back. Which algorithm is
 * chosen inside a group is, on this evidence, a coin toss.
 *
 * `leverage` having the highest mean does not change that sentence, and the
 * file's own history is why. `potshare` led on the mean at n=400 with t=2.99
 * and was nothing at n=2000; `ps-h4` was best of eight at n=800 and finished
 * behind `distinct` at n=2500. A top mean here is where a strategy goes to be
 * falsified, so the ordering inside the top group is still a coin toss and
 * the app still defaults to `joint`.
 *
 * What `leverage` *is* worth watching for is a different shape from the rest
 * of the group: it reaches the same week as `distinct` (6.53 against 6.55) and
 * takes about 9% more of the pot doing it. Every other gap in this table comes
 * with a survival gap. That is what differentiation would look like if it were
 * real -- surviving no longer, sharing less -- which makes it the right thing
 * to re-run at a larger sample and the wrong thing to switch to on today's
 * evidence.
 *
 * That is why `samePick` drives the warning rather than `xFair`. 0.98 is not
 * distinguishable from a fair share -- its standard error spans it -- so
 * tinting it as a loser would be claiming something this run did not find,
 * while "both entries on one team, every week" is simply true.
 */
export const COLLIDES = (id) => MEASURED[id]?.samePick >= 0.99;

/** One sentence naming the sample, for the top of the picker. */
export const measurementSummary = () =>
  `Rated over ${RUN.seasons.toLocaleString()} simulated seasons, two entries in a `
  + `${RUN.poolSize}-entry pool. The score is a multiple of a fair share of the pot: `
  + `1.00 is what picking with the field takes home.`;
