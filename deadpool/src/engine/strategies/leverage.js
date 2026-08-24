/**
 * `distinct`, and then the safest team the rest of the pool is least likely on.
 *
 * A port of strategy/leverage.py, and held to it by fixtures/golden.
 *
 * The first strategy here that reads the *field* rather than only the games.
 * Everything else scores matchups; this one asks a second question — of the
 * teams that keep me alive, which am I least likely to be sharing?
 *
 * ── Why that question is worth asking ───────────────────────────────────
 *
 * The pot goes to whoever gets deepest, split among however many reach that
 * week. Surviving is necessary and not sufficient: a week where you and 200
 * others all advance on one favourite moves nobody. What decides the pot is
 * the weeks where you advance and others do not.
 *
 * ── What is new here, and what is not ───────────────────────────────────
 *
 * Not new: maximising expected pot share. scripts/backtest.py has four
 * variations on it and every one was measured; none beat `distinct`, and two
 * looked like clear winners at a smaller sample and reversed. That result
 * stands and this does not relitigate it.
 *
 * New: the forecast is built from **observed inventories** rather than an
 * assumed field. /api/pool reads which teams each surviving entry has actually
 * spent, and engine/field.js turns that into what the pool is likely to do
 * this week. That input has never been available to a strategy before, and it
 * is the one thing the falsified pot-share work never had.
 *
 * ── The shape, chosen so it cannot be much worse than the best known thing --
 *
 * This is `distinct` — top of the table at the largest sample run, and the side
 * of the only crossing in it that has *grown* with the sample rather than
 * collapsed — with one addition applied after it has chosen. It moves off `distinct`'s pick only when **two**
 * conditions hold together: the alternative is within `tolerance` points of it,
 * which bounds the cost, **and** it is at least `minGain` less crowded, which
 * is what makes the move worth making. Both, or the pick stands.
 *
 * The second condition is not a refinement — it decides whether this is a
 * tie-break at all. Without it the search slides to the least-crowded team
 * anywhere in the band, always the worst team in it since share falls
 * monotonically with win probability, and there is always such a team, so the
 * move fires every week. See DEFAULT_MIN_GAIN.
 *
 * ── What it measured, which is that it does not work ────────────────────
 *
 * The third strategy here to lead a table and then collapse, kept and
 * documented rather than dropped because the collapse is the useful part.
 *
 * At n=2500 it was the highest mean of eight: 1.87x fair against `distinct`'s
 * 1.72, not separated at t = 1.60. Synthetic seasons are seeded by index, so a
 * larger run *contains* the smaller one — the checkpoint curve adds data
 * rather than drawing a fresh sample, which is the only version that can tell
 * growth from wandering. A real difference grows like the square root of n.
 * This went 1.60 at 2500, 0.75 at 5000, and at 10000 the sign flipped:
 * `distinct` leads 1.91 to 1.89, t = 0.30. `potshare` did this at n=400 and
 * `ps-h4` at n=800.
 *
 * The depth table says precisely what went wrong, which the money could not.
 * `distinct` beats this at t = 3.84 on weeks survived while the money stays a
 * dead heat at 0.30 — so it survived measurably less long and still took the
 * same share. That is the trade it was built to make, working: it gives up
 * survival to sit away from the crowd, and the differentiation pays for the
 * survival it costs, exactly, and no more. A break-even trade is not worth a
 * fetch, an inventory and a model. See engine/measured.js.
 *
 * Two properties follow and both are the point. The downside is **bounded by a
 * parameter**, spent only where a large block of the field is being avoided.
 * And with no sheet configured it is **exactly** `distinct` — the same pick,
 * not a similar one; there is a test.
 *
 * A tie-break rather than a rescoring, deliberately. A rescoring trades
 * survival for differentiation at a rate nobody has measured, which is how the
 * pot-share strategies got into trouble. This spends only what the board was
 * already giving away.
 */

import { recommendDistinct } from './distinct.js';
import {
  optionsThisWeek,
  DEFAULT_LOOKAHEAD_WEEKS, DEFAULT_PER_WEEK_TOP_K,
  DEFAULT_MAX_CANDIDATE_TEAMS, DEFAULT_BEAM_WIDTH,
} from './sequence-dp.js';
import { forecastPopularity, forecastShareOf, CASUAL_TAU } from '../field.js';
import { f1 } from '../fmt.js';

const ID = 'leverage';

/** How much advance probability, in points, may be given up to avoid the crowd. */
export const DEFAULT_TOLERANCE_PCT = 2.0;

/**
 * How much of the field the move has to actually get away from, as a share.
 *
 * A first version had no such threshold: it moved to the least-crowded team
 * anywhere inside the tolerance band, which sounds free and is not. Forecast
 * share falls monotonically with win probability, so "least crowded within two
 * points of the best" is always *the worst team within two points of the
 * best* — and there is always one, so the move fires every week. It spends the
 * full tolerance every September, when every entry still holds every team and
 * the crowding difference between neighbours is a point or two.
 *
 * Fifteen points of the field is a lot to move off. It happens when the team
 * you are leaving is one the pool is piling onto and the one you are moving to
 * is one it has largely spent — the only situation the trade ever described.
 *
 * **What the measurement says about this value, and it took two metrics to
 * say it.** `lev-g0` in scripts/backtest.py is the no-threshold version, raced
 * on the same seasons as everything else.
 *
 * On pot share it is not separated from anything: 1.83x fair against
 * `leverage`'s 1.89 and `distinct`'s 1.91, which paired is t = 0.64 and 0.75.
 * An earlier version of this comment cited its 1.67 at n=2500 as confirmation
 * that the threshold mattered. That was t = 0.26 and was never a separation,
 * so the citation was wrong even though the conclusion was right. **No
 * pot-share number justifies this parameter, and none ever did.**
 *
 * On **weeks survived** it separates decisively: `leverage` over `lev-g0` is
 * t = 4.20 and `distinct` over `lev-g0` is 5.34, over 10000 seasons with about
 * 5600 of them informative. `lev-g0` reaches week 6.32 where `leverage`
 * reaches 6.47 — a gap that looked like rounding beside an unmeasurable money
 * column and is one of the sharper results in the table once it is paired on
 * the metric that can see it.
 *
 * So the threshold is justified by measurement after all. Not by the money,
 * which cannot resolve it and never could, but by the survival it stops the
 * strategy from spending — exactly what the design argument said it was for:
 * without it the tie-break fires every single week, because there is always a
 * slightly-less-crowded team inside a two-point band.
 *
 * One withdrawn number, since it was cited here: a pilot run had the
 * no-threshold version at week 3.9 against `distinct`'s 5.7. It does not
 * reproduce — 6.32 against 6.52 at the settings the table is run at. The
 * pilot's configuration was not recorded and `lev-g0` is a re-creation rather
 * than that code, so the number goes; the mechanism, now measured, stays.
 */
export const DEFAULT_MIN_GAIN = 0.15;

/**
 * What share of the surviving field lands on each team this week.
 *
 * The board is taken from the games rather than from any entry's own view of
 * it, because the field's choice is over the whole slate and every opponent
 * holds a different inventory.
 */
export function forecastField(games, field, tau = CASUAL_TAU) {
  const names = Object.keys(field?.inventories ?? {});
  if (!names.length) return {};
  const board = optionsThisWeek(games, new Set())
    .filter((o) => o.winPct !== null && o.winPct !== undefined)
    .map((o) => [o.teamAbbreviation, o.winPct]);
  if (!board.length) return {};
  return forecastPopularity(names.map((n) => field.inventories[n]), board, tau);
}

/**
 * The least-crowded team within `tolerancePct`, if it is worth moving to.
 *
 * Two conditions, and the second is what makes this a strategy rather than a
 * slow leak: within `tolerancePct` points of `chosen`, **and** at least
 * `minGain` less crowded.
 *
 * `chosen` wins its own tie: this only ever moves for a *strictly* better
 * option, which is what makes "no field data" and "field data that changes
 * nothing" the same pick rather than merely the same probability.
 */
export function leastCrowded(
  candidates, chosen, forecast,
  tolerancePct = DEFAULT_TOLERANCE_PCT, minGain = DEFAULT_MIN_GAIN,
) {
  if (!chosen || chosen.winPct === null || chosen.winPct === undefined) return chosen;
  if (!Object.keys(forecast ?? {}).length) return chosen;

  const floor = chosen.winPct - tolerancePct;
  let best = chosen;
  let bestShare = forecastShareOf(forecast, chosen.teamAbbreviation);
  // A move has to get below this to be worth making. Without it the search
  // slides to the worst team in the band every week — see DEFAULT_MIN_GAIN.
  const ceiling = bestShare - minGain;

  for (const c of candidates) {
    if (c.winPct === null || c.winPct === undefined || c.winPct < floor) continue;
    const share = forecastShareOf(forecast, c.teamAbbreviation);
    if (share > ceiling) continue;
    if (share < bestShare) { best = c; bestShare = share; continue; }
    // A tie among movers resolves on win probability then abbreviation, so the
    // answer is deterministic. `chosen` is never displaced by an equal share.
    if (share === bestShare && best !== chosen
      && (c.winPct > best.winPct
        || (c.winPct === best.winPct && c.teamAbbreviation > best.teamAbbreviation))) {
      best = c;
    }
  }
  return best;
}

/** Why this pick and not the one `distinct` reached for. */
function describe(was, now, forecast, survivors) {
  const before = forecastShareOf(forecast, was.teamAbbreviation) * 100;
  const after = forecastShareOf(forecast, now.teamAbbreviation) * 100;
  return `${now.teamAbbreviation} instead of ${was.teamAbbreviation}: `
    + `${f1(now.winPct)}% against ${f1(was.winPct)}% to advance, and about `
    + `${after.toFixed(0)}% of the ${survivors} surviving entries land there against `
    + `${before.toFixed(0)}% on ${was.teamAbbreviation}. Surviving a week the field also `
    + `survives is worth nothing; this trades ${f1(was.winPct - now.winPct)} `
    + `points for not sharing the week.`;
}


/* --------------------------------------------------------------- the core -- */

/**
 * `distinct`'s picks, moved off the field's chalk where it is free to.
 *
 * Returns `{ picks, reasoning, collided, switched, forecast }` keyed by entry,
 * matching strategy/leverage.py. Split out of `run()` for the same reason
 * `recommendDistinct` is: the parity suite drives this directly, and a
 * strategy whose logic is only reachable through the registry contract cannot
 * be held to the Python.
 */
export function recommendLeverage(
  games, table, week, usedByEntry = {}, order = [], inventories = {}, opts = {},
) {
  const tolerance = opts.tolerancePct ?? DEFAULT_TOLERANCE_PCT;
  const minGain = opts.minGain ?? DEFAULT_MIN_GAIN;
  const tau = opts.tau ?? CASUAL_TAU;

  const { picks, reasoning, collided } = recommendDistinct(
    games, table, week, usedByEntry, order, opts,
  );

  const names = Object.keys(inventories ?? {});
  const forecast = names.length
    ? forecastField(games, { inventories }, tau)
    : {};
  const switched = {};

  if (Object.keys(forecast).length) {
    // Whatever the other entry holds this week stays off this one's board,
    // exactly as in `distinct`. Losing that here would let the forecast walk
    // both entries onto one under-owned team — the single thing the
    // measurements actually established you must not do.
    let taken = Object.values(picks).filter(Boolean).map((p) => p.teamAbbreviation);

    for (const entry of order) {
      const chosen = picks[entry];
      if (!chosen) continue;
      const others = taken.filter((t) => t !== chosen.teamAbbreviation);
      const candidates = optionsThisWeek(
        games, new Set([...(usedByEntry[entry] ?? []), ...others]),
      );
      const moved = leastCrowded(candidates, chosen, forecast, tolerance, minGain);
      if (moved === chosen) continue;

      picks[entry] = moved;
      switched[entry] = [chosen.teamAbbreviation, moved.teamAbbreviation];
      reasoning[entry] = `${describe(chosen, moved, forecast, names.length)} ${reasoning[entry] ?? ''}`.trim();
      taken = taken.map((t) => (t === chosen.teamAbbreviation ? moved.teamAbbreviation : t));
    }
  }

  return { week, picks, reasoning, collided, switched, forecast };
}

/* ------------------------------------------------ the registry contract -- */

export default {
  id: ID,
  name: 'Avoid the crowd',
  // `{distinct}` rather than the display name spelled out. A name written into
  // a second file is a fact in two places, and measured.js documents exactly
  // how that rots: rename the strategy and every sentence quoting it describes
  // something that no longer exists, silently. settings.js resolves the
  // reference and leaves it visibly broken if the id ever goes.
  blurb: 'Plans both entries the way {distinct} does, then — only where the board makes it '
    + 'nearly free — moves onto a team the rest of the pool cannot follow you to. '
    + 'Needs the pool sheet; without one it is that strategy exactly.',
  entries: 'both',
  params: [
    { key: 'tolerancePct', label: 'Give up at most', type: 'float', default: DEFAULT_TOLERANCE_PCT, min: 0, max: 10, step: 0.5, unit: 'pts', help: 'How much win probability may be traded to move off a team the field is piling onto. Zero turns this off entirely.' },
    { key: 'minGain', label: 'Only when it avoids', type: 'percent', default: DEFAULT_MIN_GAIN, min: 0, max: 0.6, step: 0.05, help: 'How much of the field the move has to get away from before it is worth giving anything up. Low values make it trade survival every week for almost nothing.' },
    { key: 'tau', label: 'How chalky the pool is', type: 'float', default: CASUAL_TAU, min: 0.1, max: 0.8, step: 0.05, help: 'Lower means the field concentrates harder on the single best team. The Pool screen shows what share your pool actually put on one team, which is the thing this is a model of — it is not the same number, so read it as a direction rather than a value to copy.' },
    { key: 'lookaheadWeeks', label: 'Plan over', type: 'int', default: DEFAULT_LOOKAHEAD_WEEKS, min: 2, max: 12, unit: 'weeks', help: 'How many weeks each entry\'s plan covers. Only the first is ever acted on.' },
    { key: 'perWeekTopK', label: 'Teams per week', type: 'int', default: DEFAULT_PER_WEEK_TOP_K, min: 2, max: 10, help: 'How many of each week\'s best teams are considered at all.' },
    { key: 'maxCandidateTeams', label: 'Search width', type: 'int', default: DEFAULT_MAX_CANDIDATE_TEAMS, min: 6, max: 20, unit: 'teams', help: 'Soft cap on distinct teams across the whole plan. Every week keeps at least one.' },
    { key: 'beamWidth', label: 'Plans carried', type: 'int', default: DEFAULT_BEAM_WIDTH, min: 50, max: 5000, step: 50, help: 'How many partial plans each search keeps.' },
  ],

  run(ctx) {
    const opts = {
      lookaheadWeeks: ctx.params.lookaheadWeeks ?? DEFAULT_LOOKAHEAD_WEEKS,
      perWeekTopK: ctx.params.perWeekTopK ?? DEFAULT_PER_WEEK_TOP_K,
      maxCandidateTeams: ctx.params.maxCandidateTeams ?? DEFAULT_MAX_CANDIDATE_TEAMS,
      beamWidth: ctx.params.beamWidth ?? DEFAULT_BEAM_WIDTH,
      tolerancePct: ctx.params.tolerancePct ?? DEFAULT_TOLERANCE_PCT,
      minGain: ctx.params.minGain ?? DEFAULT_MIN_GAIN,
      tau: ctx.params.tau ?? CASUAL_TAU,
    };
    const order = ctx.entries.map((e) => e.id);
    const usedByEntry = Object.fromEntries(order.map((id) => [id, ctx.usedTeams[id] ?? []]));

    const { picks, reasoning, collided, switched, forecast } = recommendLeverage(
      ctx.games, ctx.schedule, ctx.week, usedByEntry, order,
      ctx.field?.inventories ?? {}, opts,
    );
    const survivors = Object.keys(ctx.field?.inventories ?? {}).length;
    const hasField = Object.keys(forecast).length > 0;

    const perEntry = {};
    const out = [];
    for (const entry of ctx.entries) {
      const pick = picks[entry.id];
      perEntry[entry.id] = pick ? [pick] : [];
      const moved = switched[entry.id];
      const factors = [];
      if (pick) {
        factors.push({
          label: 'Win probability',
          value: pick.winPct === null || pick.winPct === undefined ? null : `${f1(pick.winPct)}%`,
          weight: 1,
          note: collided.includes(entry.id)
            ? 'Moved off another entry\'s team — this was not its first choice.'
            : 'Its own first choice; no other entry wanted it.',
        });
        if (hasField) {
          factors.push({
            label: 'The field here',
            value: `${(forecastShareOf(forecast, pick.teamAbbreviation) * 100).toFixed(0)}%`,
            weight: 1,
            note: moved
              ? `Moved off ${moved[0]}, where more of the pool is expected.`
              : `Forecast from what the ${survivors} surviving entries have already spent.`,
          });
        }
      }
      out.push({ entry: entry.id, candidate: pick, reasoning: reasoning[entry.id], factors });
    }

    const warnings = [];
    if (!hasField) {
      // The one warning worth firing every week it applies: this strategy is
      // chosen *for* the field-reading, and without a sheet it is silently a
      // different strategy. Saying so is the difference between an honest
      // fallback and a feature that appears to work.
      warnings.push({
        level: 'warn',
        text: 'No pool sheet, so there is no field to read and this is identical to "Different team for each entry".',
      });
    }
    if (ctx.scheduleWeeks <= 1) {
      warnings.push({ level: 'warn', text: 'Only this week is loaded, so there is no sequence to plan and this ranks identically to win probability.' });
    }

    return { strategyId: ID, picks: out, candidates: perEntry, considered: Object.values(perEntry).reduce((n, c) => n + c.length, 0), warnings };
  },
};
