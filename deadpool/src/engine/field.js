/**
 * What the pool's own sheet says about everybody else.
 *
 * Every other module in this engine scores *games*. This one is the only thing
 * that scores *opponents*, and it is the observed half of what
 * `scripts/field.py` simulates. The distinction matters more than it looks:
 *
 *   `field.py`      250 opponents, invented, each given an inventory by a
 *                   model of how a survivor pool behaves. Used to *measure*
 *                   strategies over thousands of seasons.
 *   this file        the actual field, read from the actual sheet. Used to
 *                   *decide*, on an actual Sunday.
 *
 * ── Two things arrive here and they have very different standing ────────
 *
 * **Inventories are exact.** Once a week is visible you know precisely which
 * teams each surviving entry can no longer pick. Nothing is estimated,
 * smoothed or fitted. `spentShare()` below is arithmetic over a set.
 *
 * **Popularity is observed for past weeks only.** You never see the current
 * week before deciding — that is the whole structure of a survivor pool — so
 * this can never tell you what the field is about to do. What it is for is
 * fitting a prior against *this* pool rather than a national average from
 * pools full of different people.
 *
 * Anything that blurs those two apart is the bug this module exists to avoid,
 * so they are separate fields with separate names and neither is derived from
 * the other.
 *
 * ── Why a strategy may read this at all ─────────────────────────────────
 *
 * The purity rule (see index.js) is that a strategy may not fetch, read a
 * clock or draw a random number, because a season has to be replayable from
 * frozen weeks. Field data does not break that: it is an input, handed in
 * already fetched and frozen, exactly like `games` and `schedule`. Replaying
 * Week 12 with the Week 12 sheet gives the answer it gave on the day.
 *
 * Provenance — when it was fetched, whether it was live — deliberately does
 * *not* travel on the field object. It sits beside it on the context as
 * `fieldSource`, for the same reason `source` does: a decision that changed
 * with the age of the data would not be replayable. The interface may say how
 * old this is. A strategy may not ask.
 *
 * ── The empty case is a value, not a null ───────────────────────────────
 *
 * Most deployments have no sheet configured, and every week before Week 1 has
 * nothing observed even when one is. `EMPTY_FIELD` is that state, with the
 * same shape as a full one, so a strategy reads `ctx.field.observed` and
 * branches on a boolean rather than null-checking four levels of object. A
 * strategy that ignores the field entirely — which is all six of them today —
 * is unaffected either way.
 */

/** Frozen, and the shape every consumer can rely on existing. */
export const EMPTY_FIELD = Object.freeze({
  /** Is there a sheet configured for this deployment at all? */
  configured: false,
  /** Is there at least one observed week in it? */
  observed: false,
  /** Surviving entries, by name, each with the set of teams it has spent. */
  inventories: Object.freeze({}),
  /** Observed share per team, by week. Past weeks only, and never the current one. */
  popularity: Object.freeze({}),
  /** Weeks the sheet carries. */
  weeks: Object.freeze([]),
  /** The most recent week with picks in it. */
  latestWeek: null,
  /** How many entries are still in, and how many there were to begin with. */
  alive: 0,
  total: 0,
  /** Whatever the parser could not make sense of, carried rather than swallowed. */
  problems: Object.freeze([]),
});

/**
 * The `/api/pool` payload, in the shape the engine reads.
 *
 * Takes the response whole and returns `EMPTY_FIELD` for every way it can fail
 * — unconfigured, unreachable, a sign-in page, a sheet that parsed to nothing.
 * The caller has already been told which of those happened and has better
 * words for it than this module does; what a *strategy* needs to know is only
 * whether there is anything to reason about.
 */
export function makeField(payload) {
  if (!payload || payload.configured === false || payload.ok === false) return EMPTY_FIELD;

  const inventories = Object.freeze(Object.fromEntries(
    Object.entries(payload.inventories ?? {}).map(([name, teams]) => [
      name, Object.freeze([...new Set(teams ?? [])].sort()),
    ]),
  ));

  const popularity = Object.freeze(Object.fromEntries(
    Object.entries(payload.popularity ?? {})
      .map(([week, shares]) => [Number(week), Object.freeze({ ...shares })])
      // A week with no picks in it is not an observation of "nobody picked".
      // It is the sheet not having got there yet, and carrying it as an empty
      // object would make `observedWeeks` count weeks nobody has played.
      .filter(([, shares]) => Object.keys(shares).length > 0),
  ));

  const weeks = Object.freeze([...(payload.weeks ?? [])].map(Number).sort((a, b) => a - b));
  const observedWeeks = Object.keys(popularity).map(Number);

  return Object.freeze({
    configured: true,
    observed: Object.keys(inventories).length > 0 || observedWeeks.length > 0,
    inventories,
    popularity,
    weeks,
    latestWeek: observedWeeks.length ? Math.max(...observedWeeks) : (payload.latestWeek ?? null),
    alive: Number(payload.alive ?? 0),
    total: Number(payload.entries ?? 0),
    problems: Object.freeze([...(payload.problems ?? [])]),
  });
}

/**
 * For each team, the share of surviving entries that have already spent it.
 *
 * **This is the exact number**, and it is the one worth having. A team 80% of
 * survivors have burned is a team 80% of survivors *cannot take*, whatever
 * they think of it — which is why a good team can be cheap in Week 14 and why
 * `field.py` models inventories at all rather than just pick popularity.
 *
 * Returned as a share rather than a count so it reads the same against a field
 * of 250 and a field of 12, and keyed by every team named in any inventory —
 * a team nobody has spent is absent rather than zero, because "no survivor has
 * used Cleveland" and "Cleveland is not in this pool's universe" are the same
 * observation from this file's position and it should not pretend otherwise.
 * Ask with `spentShareOf`, which answers 0 for an unseen team.
 */
export function spentShare(field) {
  const names = Object.keys(field?.inventories ?? {});
  if (!names.length) return Object.freeze({});

  const counts = {};
  for (const name of names) {
    for (const team of field.inventories[name]) counts[team] = (counts[team] ?? 0) + 1;
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(counts).map(([team, n]) => [team, n / names.length]),
  ));
}

/** The share for one team, where never-spent reads 0 rather than undefined. */
export const spentShareOf = (shares, team) => shares?.[team] ?? 0;

/**
 * How many surviving entries could still take each team.
 *
 * The complement of `spentShare`, as a count, because this is the one that
 * gets compared against the number of survivors rather than plotted.
 */
export function stillAvailableTo(field, team) {
  const names = Object.keys(field?.inventories ?? {});
  return names.filter((name) => !field.inventories[name].includes(team)).length;
}

/**
 * What the field actually did in one past week.
 *
 * Returns `{}` for the current week and for any week not on the sheet, which
 * are the same answer from here and must stay that way: a caller that could
 * tell them apart would be a caller reaching for this week's picks, and this
 * week's picks are precisely what a survivor pool never shows you in time.
 */
export const observedPopularity = (field, week) => field?.popularity?.[Number(week)] ?? {};

/**
 * The share taken by each week's single most-popular team.
 *
 * `[{ week, top, team }]`, ascending by week. A pool where everybody piles
 * onto the same favourite reads near 1; one that spreads out reads low.
 *
 * Per week rather than averaged, and that is the whole point of the shape.
 * `fit_tau` in scripts/field.py carries the warning this has to respect: fit
 * on **Week 1 or another full-inventory week**, because by Week 6 a field
 * looks more spread out than it is simply from having spent the chalk. That
 * is inventory exhaustion, not sharpness, and a mean over all weeks folds the
 * two together into a number that reads a disciplined pool as a clever one.
 * The earliest week is the least confounded, so callers want the series and
 * the ability to say which week they took.
 */
export function chalkinessByWeek(field) {
  return Object.keys(field?.popularity ?? {})
    .map(Number)
    .sort((a, b) => a - b)
    .map((week) => {
      const shares = Object.entries(field.popularity[week] ?? {});
      if (!shares.length) return { week, top: 0, team: null };
      const [team, top] = shares.reduce((a, b) => (b[1] > a[1] ? b : a));
      return { week, top, team };
    });
}

/**
 * How chalky this pool has been, as one number in [0, 1].
 *
 * The mean of the above. Kept because "roughly how chalky is this pool" is a
 * fair question with a one-number answer, and shown next to the per-week
 * series rather than instead of it — on its own it is the confounded average
 * `chalkinessByWeek` exists to avoid.
 *
 * `null` when nothing has been observed, rather than a neutral-looking 0.5
 * that would read as a measurement.
 */
export function observedChalkiness(field) {
  const rows = chalkinessByWeek(field);
  if (!rows.length) return null;
  return rows.reduce((a, r) => a + r.top, 0) / rows.length;
}

/* ------------------------------------------------------------- forecast -- */

/**
 * The concentration ladder, and how hard win probability drives the choice.
 *
 * A port of the constants in models/field_forecast.py, which is where the
 * prose explaining them lives. `tau` is how tightly the field converges on one
 * team: lower is chalkier. `scripts/field.py`'s `fit_tau` turns an observed
 * week into the tau that produced it, which is what `observedChalkiness` above
 * is the raw material for.
 */
export const CASUAL_TAU = 0.35;
export const AVERAGE_TAU = 0.25;
export const SHARP_TAU = 0.15;
export const POPULARITY_BETA = 1.0;

const logit = (p) => {
  const c = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(c / (1 - c));
};

/**
 * Multinomial-logit weights over `[team, winPct]` candidates.
 *
 * Shifted by the maximum before exponentiating, which changes no ratio and
 * keeps a sharp tau from overflowing. Port of `pick_weights`.
 */
export function pickWeights(candidates, tau = CASUAL_TAU, beta = POPULARITY_BETA) {
  if (!candidates.length) return [];
  const scores = candidates.map(([, p]) => (beta * logit(p / 100)) / tau);
  const top = Math.max(...scores);
  return scores.map((s) => Math.exp(s - top));
}

/**
 * What share of the surviving field lands on each team this week.
 *
 * Port of `popularity_from_inventories`. Averaged over each opponent's *own*
 * inventory rather than computed once over the board, which is the whole point:
 * two entries with different teams left do not face the same choice, and by
 * Week 10 that difference is most of what determines popularity.
 *
 * A team no surviving entry can still take is **absent** from the result rather
 * than present at zero — it never entered anybody's choice, and that is a
 * different statement from having been scored and come out at nothing. Read it
 * through `forecastShareOf`, which is where the zero belongs. Same rule as
 * `spentShare` above, for the same reason.
 */
export function forecastPopularity(inventories, candidates, tau = CASUAL_TAU, beta = POPULARITY_BETA) {
  const board = candidates.filter(([, p]) => p !== null && p !== undefined);
  if (!board.length) return Object.freeze({});

  // Entries with the same teams spent face the same choice, so the weights are
  // computed once per *distinct* inventory rather than once per entry — in
  // Week 1 that is every entry sharing one empty inventory.
  const cache = new Map();
  const shares = {};
  let counted = 0;

  for (const used of inventories) {
    const spent = new Set(used);
    const key = [...spent].sort().join(',');
    let hit = cache.get(key);
    if (!hit) {
      const mine = board.filter(([team]) => !spent.has(team));
      const weights = pickWeights(mine, tau, beta);
      hit = { mine, weights, total: weights.reduce((a, b) => a + b, 0) };
      cache.set(key, hit);
    }
    if (hit.total <= 0) continue;
    counted += 1;
    hit.mine.forEach(([team], i) => {
      shares[team] = (shares[team] ?? 0) + hit.weights[i] / hit.total;
    });
  }

  if (!counted) return Object.freeze({});
  return Object.freeze(Object.fromEntries(
    Object.entries(shares).map(([team, s]) => [team, s / counted]),
  ));
}

/** A forecast share, where a team nobody can take reads 0 rather than undefined. */
export const forecastShareOf = (forecast, team) => forecast?.[team] ?? 0;

/**
 * The forecast for one week's board, from a field read off the sheet.
 *
 * The join between `/api/pool`'s inventory table and the model — the same one
 * `forecast_for_pool` provides on the Python side, so a strategy reads one
 * function whether the field was simulated or observed. Returns `{}` when
 * there is no field, which is the signal a caller uses to fall through to
 * whatever it would have done without one.
 */
export function forecastFor(field, candidates, tau = CASUAL_TAU) {
  const names = Object.keys(field?.inventories ?? {});
  if (!names.length) return Object.freeze({});
  return forecastPopularity(names.map((n) => field.inventories[n]), candidates, tau);
}
