"""`distinct`, and then the safest team the rest of the pool is least likely on.

This is the first strategy here that reads the *field* rather than only the
games. Everything else in `strategy/` scores matchups; this one asks a second
question — of the teams that keep me alive, which one am I least likely to be
sharing with everybody else?

── Why that question is worth asking ───────────────────────────────────────

A survivor pool pays whoever gets deepest, split among however many reach that
week. Surviving is necessary and is not sufficient: a week where you and 200
others all advance on the same favourite moves nobody. The pot is decided by
the weeks where you advance and others do not.

The harness has been saying this from the other direction for a while.
`scripts/field.py` reaches the historical 73%-a-week public survival rate with
no carelessness modelled at all, because an entry cannot keep taking the chalk
it spent in September. Inventory exhaustion is the mechanism, and it is a
mechanism you can *read* once the pool's sheet is in hand.

── What is new here, and what is not ───────────────────────────────────────

Not new: maximising expected pot share. `scripts/backtest.py` has four
variations on it — `potshare` and the `ps-h*` horizon sweep — and every one of
them was measured and none beat `distinct`. Two of them looked like clear
winners at a smaller sample and reversed. That result stands and this strategy
does not relitigate it.

New: the forecast is built from **observed inventories** rather than an assumed
field. `/api/pool` reads which teams each surviving entry has actually spent,
and `models/field_forecast.py` turns that into what the pool is likely to do
this week. That input has never been available to a strategy before, and it is
the one thing the falsified pot-share work never had.

── The shape, chosen so it cannot be much worse than the best known thing ──

This is `distinct` — top of the table at the largest sample run, and the side
of the only crossing in it that has *grown* with the sample rather than
collapsed — with one addition applied after it has chosen.

`distinct` produces a pick. This will move off it only when **two** conditions
hold together, and the second one was learned by measuring:

1. The alternative is within `tolerance` points of that pick's advance
   probability, which bounds what the move can cost.
2. It is at least `min_gain` *less crowded*, which is what makes the move worth
   making at all.

Both, or the pick stands. If there is no field data it returns `distinct`'s
pick unchanged.

The second condition is not a refinement, it decides whether this is a
tie-break at all. Without it the search slides to the least-crowded team
anywhere in the band — and since forecast share falls monotonically with win
probability, that is always *the worst team in the band*. There is always such
a team, so the move fires every week, which is a rescoring wearing a
tie-break's clothes. See DEFAULT_MIN_GAIN, which records what that costs and
what the measurement did *not* establish about it.

── What it measured, which is that it does not work ────────────────────────

This is the third strategy in this repository to lead a table and then
collapse, and it is documented here rather than quietly dropped because the
collapse is the useful part.

At n=2,500 it was the highest mean of eight: 1.87x fair against `distinct`'s
1.72, not separated at t = 1.60. The seasons are seeded by index, so a larger
run *contains* the smaller one and the checkpoint curve is a genuine
"add more data" curve rather than three independent samples. A real difference
grows like the square root of n. This one went t = 1.60 at 2,500, 0.75 at
5,000, and at 10,000 the sign flipped — `distinct` now leads it 1.91 to 1.89,
t = 0.30. `potshare` did this at n=400 and `ps-h4` at n=800.

What is left is real and is not an edge: reading the field beats `joint` at
t = 2.15, which is precisely what `distinct` does without reading anything. So
the field forecast costs a fetch, an inventory and a model, and buys nothing
over keeping the two entries on different teams. The app defaults to
`distinct`; this stays registered, honestly rated, and unrecommended.

Two properties follow from the corrected shape and both are the point:

* The downside is **bounded by a parameter**, and is only ever spent where a
  large block of the field is actually being avoided.
* With no sheet configured it is **exactly** `distinct`, not approximately —
  same code path, same pick. Most deployments will never see a difference, and
  a test asserts it rather than assuming it.

It is deliberately a tie-break rather than a rescoring. A rescoring would trade
survival for differentiation at a rate nobody has measured, which is how the
pot-share strategies got into trouble. A tie-break spends only what the board
was giving away.

── What it does not do ─────────────────────────────────────────────────────

It does not forecast the *current* week's picks from the current week's picks,
because a pool never shows you those in time. The forecast is built from
inventories — what everybody has already spent, which is exact and visible —
run through the same model that generates the simulated field.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from data.models import Game
from models.field_forecast import CASUAL_TAU, POPULARITY_BETA, popularity_from_inventories
from models.win_prob import TeamWeekWinProbability
from strategy import distinct, sequence_dp

ENTRY_A_NAME = "Entry A"
ENTRY_B_NAME = "Entry B"

# How much advance probability, in percentage points, may be given up to move
# off a team the field is piling onto.
#
# Two points is about the width of the band the board hands you for free in a
# typical week -- the gap between the best team and the second or third is
# usually smaller than that, and where it is not, this does nothing at all.
# Deliberately small: the measured result this strategy is built on top of is
# worth more than any unmeasured differentiation, so the differentiation is
# only ever paid for out of what was already a tie.
DEFAULT_TOLERANCE_PCT = 2.0

# How much of the field the move has to actually get away from, as a share.
#
# A first version had no such threshold: it moved to the least-crowded team
# anywhere inside the tolerance band, which sounds like a free trade and is
# not. Forecast share falls monotonically with win probability, so "least
# crowded within two points of the best" is always *the worst team within two
# points of the best* -- and there is always one, so the move fires every week.
# It spends the full tolerance every September, when every entry still holds
# every team and the crowding difference between neighbours is a point or two.
#
# So a switch has to buy real differentiation. Fifteen points of the field is a
# lot to move off -- it happens when the team you are leaving is one the pool
# is piling onto and the team you are moving to is one it has largely spent,
# which is the only situation the trade was ever supposed to describe.
#
# **What the measurement says about this value, stated carefully, because an
# earlier version of this comment overstated it.** `lev-g0` in
# scripts/backtest.py is the no-threshold version, raced on the same seasons as
# everything else. Over 10,000 it takes 1.83x fair against `leverage`'s 1.89
# and `distinct`'s 1.91 -- but paired, that is t = 0.64 and t = 0.75, and this
# file's own bar is that under 2 is not a difference. At the 2,500-season
# sample first cited here it was t = 0.26, which was never a separation either.
# **No pot-share number justifies this parameter.**
#
# What does survive is the survival cost, which is smaller and points the same
# way at both samples: `lev-g0` reaches week 6.32 where `leverage` reaches 6.47
# and `distinct` 6.52. Giving up two points of advance probability every week
# is what it does by construction, and eighteen weeks of it show up as about a
# fifth of a week. The threshold is kept because a tie-break that fires
# unconditionally is not a tie-break, not because a race said so.
#
# One withdrawn number, since it was cited here: a pilot run had the
# no-threshold version at week 3.9 against `distinct`'s 5.7. It does not
# reproduce -- 6.32 against 6.52 at the settings the table is run at. The
# pilot's configuration was not recorded and `lev-g0` is a re-creation rather
# than that code, so the number goes rather than the mechanism.
DEFAULT_MIN_GAIN = 0.15


@dataclass
class LeverageRecommendation:
    """One pick per entry, plus what the field forecast actually changed."""

    week: int
    picks: Dict[str, Optional[sequence_dp.WeekPick]] = field(default_factory=dict)
    reasoning: Dict[str, str] = field(default_factory=dict)
    collided: List[str] = field(default_factory=list)
    # Entries whose pick this strategy moved off `distinct`'s answer, and to
    # what. Reported rather than inferred, because "did the new input change
    # anything this week" is the only question worth asking of it.
    switched: Dict[str, Tuple[str, str]] = field(default_factory=dict)
    forecast: Dict[str, float] = field(default_factory=dict)


def _candidates_this_week(
    games: Sequence[Game], used: Sequence[str],
) -> List[sequence_dp.WeekPick]:
    """Every team still available to one entry, with its advance probability."""
    return sequence_dp._options_this_week(games, set(used))


def forecast_field(
    games: Sequence[Game],
    inventories: Mapping[str, Sequence[str]],
    tau: float = CASUAL_TAU,
    beta: float = POPULARITY_BETA,
) -> Dict[str, float]:
    """What share of the surviving field lands on each team this week.

    The board is taken from the games rather than from any entry's own view of
    it, because the field's choice is over the whole slate and every opponent
    has a different inventory. Returns ``{}`` when there is nothing to go on,
    which is the signal the caller uses to fall straight through to `distinct`.
    """
    if not inventories:
        return {}
    board = [
        (c.team_abbreviation, c.win_pct)
        for c in _candidates_this_week(games, ())
        if c.win_pct is not None
    ]
    if not board:
        return {}
    return popularity_from_inventories(
        [set(used) for used in inventories.values()], board, tau, beta,
    )


def least_crowded(
    candidates: Sequence[sequence_dp.WeekPick],
    chosen: sequence_dp.WeekPick,
    forecast: Mapping[str, float],
    tolerance_pct: float = DEFAULT_TOLERANCE_PCT,
    min_gain: float = DEFAULT_MIN_GAIN,
) -> sequence_dp.WeekPick:
    """The least-crowded team within `tolerance_pct`, if it is worth moving to.

    Two conditions, and the second is the one that makes this a strategy rather
    than a slow leak. The candidate must be within `tolerance_pct` points of
    `chosen` -- that bounds what the move can cost -- **and** it must be at
    least `min_gain` less crowded, which is what stops the search sliding down
    to the worst team in the band every week for a percentage point of
    differentiation. See DEFAULT_MIN_GAIN.

    Ties among movers fall back to win probability and then the abbreviation,
    so the answer is deterministic. `chosen` wins its own tie: this only moves
    for a *strictly* better option, which is what makes "no field data" and
    "field data that changes nothing" the same pick rather than merely the same
    probability.
    """
    if chosen is None or chosen.win_pct is None or not forecast:
        return chosen

    floor = chosen.win_pct - tolerance_pct
    here = forecast.get(chosen.team_abbreviation, 0.0)
    ceiling = here - min_gain          # a move has to get below this to be worth it

    best = chosen
    best_share = here
    for c in candidates:
        if c.win_pct is None or c.win_pct < floor:
            continue
        share = forecast.get(c.team_abbreviation, 0.0)
        if share > ceiling:
            continue
        if share < best_share or (
            share == best_share and best is not chosen and (
                (c.win_pct, c.team_abbreviation) > (best.win_pct, best.team_abbreviation)
            )
        ):
            best, best_share = c, share
    return best


def _describe(
    entry: str, base: sequence_dp.WeekPick, moved: sequence_dp.WeekPick,
    forecast: Mapping[str, float], survivors: int,
) -> str:
    """Why this pick and not the one `distinct` reached for."""
    if moved is base:
        return ""
    was = forecast.get(base.team_abbreviation, 0.0) * 100.0
    now = forecast.get(moved.team_abbreviation, 0.0) * 100.0
    return (
        f"{moved.team_abbreviation} instead of {base.team_abbreviation}: "
        f"{moved.win_pct:.1f}% against {base.win_pct:.1f}% to advance, and about "
        f"{now:.0f}% of the {survivors} surviving entries land there against "
        f"{was:.0f}% on {base.team_abbreviation}. Surviving a week the field also "
        f"survives is worth nothing; this trades {base.win_pct - moved.win_pct:.1f} "
        f"points for not sharing the week."
    )


def recommend(
    current_week_games: Sequence[Game],
    win_prob_table: Dict[Tuple[str, int], TeamWeekWinProbability],
    current_week: int,
    used_teams_by_entry: Optional[Dict[str, List[str]]] = None,
    entry_order: Sequence[str] = (ENTRY_A_NAME, ENTRY_B_NAME),
    field_inventories: Optional[Mapping[str, Sequence[str]]] = None,
    tolerance_pct: float = DEFAULT_TOLERANCE_PCT,
    min_gain: float = DEFAULT_MIN_GAIN,
    tau: float = CASUAL_TAU,
    **options,
) -> LeverageRecommendation:
    """`distinct`'s picks, moved off the field's chalk where it is free to.

    ``field_inventories`` is ``{entry name: [teams spent]}`` for the *surviving*
    opponents, which is the shape `/api/pool` returns. Absent or empty, this is
    `distinct` exactly.
    """
    base = distinct.recommend(
        current_week_games, win_prob_table, current_week,
        used_teams_by_entry=used_teams_by_entry, entry_order=entry_order, **options,
    )

    out = LeverageRecommendation(
        week=current_week,
        picks=dict(base.picks),
        reasoning=dict(base.reasoning),
        collided=list(base.collided),
    )

    inventories = dict(field_inventories or {})
    forecast = forecast_field(current_week_games, inventories, tau=tau)
    out.forecast = forecast
    if not forecast:
        return out

    used_by_entry = dict(used_teams_by_entry or {})
    # Whatever the other entry has been given this week is off the board for
    # this one, exactly as in `distinct`. Losing that here would let the field
    # forecast walk both entries onto one team, which is the single thing the
    # measurements actually established you must not do.
    taken = [p.team_abbreviation for p in base.picks.values() if p is not None]

    for entry in entry_order:
        chosen = base.picks.get(entry)
        if chosen is None:
            continue
        mine = list(used_by_entry.get(entry, []))
        others = [t for t in taken if t != chosen.team_abbreviation]
        candidates = _candidates_this_week(current_week_games, mine + others)

        moved = least_crowded(candidates, chosen, forecast, tolerance_pct, min_gain)
        if moved is chosen:
            continue

        out.picks[entry] = moved
        out.switched[entry] = (chosen.team_abbreviation, moved.team_abbreviation)
        note = _describe(entry, chosen, moved, forecast, len(inventories))
        out.reasoning[entry] = f"{note} {base.reasoning.get(entry, '')}".strip()
        # Keep the exclusion list current so the second entry cannot be walked
        # onto the team the first one just moved to.
        taken = [moved.team_abbreviation if t == chosen.team_abbreviation else t for t in taken]

    return out
