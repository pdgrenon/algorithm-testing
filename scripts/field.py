"""A simulated pool of 250 opponents, so a strategy can be scored on pot share.

Weeks survived is the wrong metric and always was. It measures how long you
lasted, and this pool pays out on how long you lasted **relative to everybody
else** -- the pot splits among whoever gets deepest, so surviving to Week 12 is
worth everything if the field died in Week 11 and worth nothing if half of them
reached Week 14. Nothing in the harness could tell those apart until now,
because there was no field in it.

── What an opponent is ─────────────────────────────────────────────────────

An entry with its own used-team inventory, carried forward week by week. That
is the part that is easy to skip and expensive to skip: model the field as an
aggregate "70% took the favourite" and late-season dynamics come out wrong,
because the reason a team is cheap in Week 14 is precisely that most survivors
already spent them. Inventories are the mechanism, so inventories are modelled.

── How an opponent picks ───────────────────────────────────────────────────

A multinomial logit over the teams still in their inventory:

    weight(t) ∝ exp( beta * logit(p_t) / tau )

with `tau` the **concentration**: as tau falls the field converges on the
single best team, as it rises it spreads out. This is the quantity real
popularity data measures -- what share of the field lands on the most popular
pick. A $10 buy-in filters for a public, chalk-following field, so the default
sits at the casual end, about 47% on the top team.

This is a *prior*, not an observation, and it is the weakest thing in the whole
harness. Real popularity data would replace it -- and in this pool picks become
visible after kickoff each week, which means the inventories can eventually be
tracked exactly and tau fitted against the real field rather than assumed.
Until then every pot-share figure this produces is conditional on the field
behaving like this model, and should be read that way.

── Why the field dies at the historical rate without being made careless ───

The field has to reproduce a known fact: roughly 27% of live survivor entries
are eliminated in a given week, so about 73% survive. A first attempt hit that
by turning the field's spread up until it died at the right rate, which is the
wrong mechanism, and measuring says so:

    the single best team by win probability wins **83.3%** of weeks (2015-2024)

A field picking favourites cannot survive at 73% in any single week. So a
second attempt added a `slip` parameter -- the chance an entry misses the
deadline or takes its own team -- to close the ten-point gap. That turned out
to be unnecessary, and the reason is the interesting part.

Simulated with a realistic concentration (about 47% of the field on the most
popular team) and **no slip at all**, the field survives at **0.722** a week.
The gap closes by itself, because an entry cannot keep taking the chalk: it
spent those teams in September. By October the popular choice is gone from most
inventories and the field is forced onto progressively worse ones.

That is inventory exhaustion, and it is the same mechanism that makes a greedy
strategy lose. It is satisfying to find it here from the other direction: the
historical public survival rate is not evidence that the public picks badly, it
is evidence that picking the best available team every week is a losing plan
over a season.

`slip` is kept, defaulting to zero, because a real field does contain entries
that forget -- but it is no longer load-bearing, and turning it up now makes
the field die *faster* than the historical rate rather than matching it.

── The one bias worth naming ───────────────────────────────────────────────

Opponents are simulated as picking from the *same* win probabilities the
strategy under test is using. That makes the field neither sharper nor duller
than the model, which is a strong assumption and a convenient one. It means
this measures decision quality against a field with the same information, not
edge against a field that is worse informed -- and the second is where a real
edge would come from.
"""
from __future__ import annotations

import math
import random
from functools import lru_cache
from dataclasses import dataclass, field as dc_field
from typing import Dict, List, Mapping, Optional, Sequence, Set, Tuple

# Sharpness of the simulated field. Lower converges on the chalk; higher
# spreads out. A $10 buy-in implies a public field, so the default leans that
# way -- but it is a guess and is the first thing to replace with real data.
# Concentration, as the share of a full-inventory field landing on the most
# popular team in Week 1. Measured over 60 generated boards rather than one
# hand-written slate, which is what the earlier figures here were:
#
#     tau    top pick   top three
#     0.15        73%         94%   sharp
#     0.25        57%         84%   average
#     0.35        45%         72%   casual (default)
#
# The old comment said 47/68/91. Only the first was close; a board with an
# unusually dominant favourite concentrates far more than a typical one, and
# these numbers exist to be compared against a real sheet, so being out by
# eighteen points on "sharp" would send somebody to the wrong tau.
#
# `fit_tau` below turns an observed Week 1 into the tau that produced it.
# Moved to models/field_forecast.py, and re-exported here so every existing
# caller and test keeps working. The move was forced: strategy/leverage.py now
# reads this same model to forecast what the pool will do, and the engine may
# not import from scripts/ -- that is the rule keeping a fetch out of the
# suite. Two copies of a scoring function drift, and these two have to agree
# exactly or a measured edge is an artefact of the disagreement.

# The chance an entry picks off-model in a given week: missed the deadline,
# took their own team, chased last week's result. **Zero by default**, because
# it turned out not to be needed -- inventory exhaustion alone brings the field
# to the historical survival rate, and adding slip on top pushes it below.
# Kept because a real field does contain entries that forget, and because being
# able to turn it up is how you find out whether a strategy's edge depends on
# opponents being careless.
DEFAULT_SLIP = 0.0

# What the field is calibrated against, and what it actually produces. Used for
# reporting and in the tests; never read by a scoring path.
TARGET_WEEKLY_SURVIVAL = 0.73      # historical public rate
CHALK_WEEKLY_SURVIVAL = 0.833      # the best team, one week, full inventory
MODELLED_WEEKLY_SURVIVAL = 0.722   # this field, no slip, from exhaustion alone


from models.field_forecast import (  # noqa: E402
    AVERAGE_TAU, CASUAL_TAU, POPULARITY_BETA, SHARP_TAU,
    _logit, pick_weights, popularity_from_inventories,
)

__all__ = [
    "AVERAGE_TAU", "CASUAL_TAU", "POPULARITY_BETA", "SHARP_TAU",
    "_logit", "pick_weights", "popularity_from_inventories",
]

@dataclass
class Opponent:
    """One entry in the field: an inventory and how far it got."""

    entry_id: str
    used: Set[str] = dc_field(default_factory=set)
    last_week_survived: int = 0
    alive: bool = True


def choose(
    candidates: Sequence[Tuple[str, float]],
    rng: random.Random,
    tau: float = CASUAL_TAU,
    slip: float = DEFAULT_SLIP,
) -> Optional[str]:
    """One opponent's pick for one week.

    Two draws, not one. First whether this entry engaged with the board at all;
    if it slipped, the pick is uniform over what it has left. Otherwise it is
    sampled from the popularity model. See the note on why these are separate.
    """
    if not candidates:
        return None
    if slip > 0 and rng.random() < slip:
        return candidates[rng.randrange(len(candidates))][0]
    weights = pick_weights(candidates, tau)
    total = sum(weights)
    if total <= 0:
        return candidates[0][0]
    draw = rng.random() * total
    for (team, _), w in zip(candidates, weights):
        draw -= w
        if draw <= 0:
            return team
    return candidates[-1][0]


def build_field(pool_size: int, my_entries: Sequence[str]) -> Dict[str, Opponent]:
    """The whole pool, yours included.

    Your own entries are in the field because they are in the denominator. With
    two of them they are in it twice, which is the arithmetic mistake this
    structure exists to make impossible rather than merely discouraged.
    """
    field: Dict[str, Opponent] = {e: Opponent(entry_id=e) for e in my_entries}
    for i in range(pool_size - len(my_entries)):
        field[f"opp{i:04d}"] = Opponent(entry_id=f"opp{i:04d}")
    return field


def advance(
    opponent: Opponent,
    candidates: Sequence[Tuple[str, float]],
    outcomes: Dict[Tuple[int, str], str],
    week: int,
    rng: random.Random,
    tau: float = CASUAL_TAU,
    slip: float = DEFAULT_SLIP,
) -> None:
    """Give one opponent a pick for ``week`` and settle it.

    An entry with nothing left to pick is eliminated where it stands rather
    than skipping the week: running out of teams ends a run, it does not pause
    one.
    """
    if not opponent.alive:
        return
    available = [(t, p) for t, p in candidates if t not in opponent.used]
    team = choose(available, rng, tau, slip)
    if team is None:
        opponent.alive = False
        return

    opponent.used.add(team)
    result = outcomes.get((week, team))
    if result is None:
        opponent.alive = False       # unplayed: the season stops here
        return
    if result == "win":
        opponent.last_week_survived = week
    else:
        opponent.alive = False


def popularity_forecast(
    pool: Mapping[str, Opponent],
    candidates: Sequence[Tuple[str, float]],
    exclude: Sequence[str] = (),
    tau: float = CASUAL_TAU,
    beta: float = POPULARITY_BETA,
) -> Dict[str, float]:
    """The same thing, read off a live pool. See popularity_from_inventories."""
    skip = set(exclude)
    return popularity_from_inventories(
        [o.used for k, o in pool.items() if k not in skip and o.alive],
        candidates, tau, beta,
    )


def fit_tau(
    observed: Mapping[str, float],
    candidates: Sequence[Tuple[str, float]],
    beta: float = POPULARITY_BETA,
    lo: float = 0.05,
    hi: float = 2.0,
) -> Optional[float]:
    """The tau whose modelled popularity best matches what the field did.

    Everything this harness concludes is conditional on how chalky the pool is,
    and that is a prior until a real sheet arrives. This is what replaces it:
    hand it one week's observed shares -- `PoolSheet.popularity(week)` or the
    `/api/pool` response -- together with that week's board, and it returns the
    concentration that would have produced them.

    Fit on **Week 1 or another full-inventory week** where possible. Later
    weeks are confounded: by Week 6 the field looks more spread out than it is
    simply because the chalk has been spent, which is inventory exhaustion
    rather than sharpness, and fitting there reads a disciplined field as a
    clever one.

    Least squares over the shares of the teams actually picked, minimised by
    golden-section search -- the objective is smooth and one-dimensional, so
    there is nothing to be gained from anything cleverer. Returns None when
    there is nothing to fit.
    """
    live = {t: s for t, s in observed.items() if s > 0}
    if not live or not candidates:
        return None

    def error(tau: float) -> float:
        weights = pick_weights(candidates, tau, beta)
        total = sum(weights)
        if total <= 0.0:
            return float("inf")
        modelled = {team: w / total for (team, _), w in zip(candidates, weights)}
        return sum((modelled.get(team, 0.0) - share) ** 2 for team, share in live.items())

    invphi = (5 ** 0.5 - 1) / 2
    a, b = lo, hi
    c, d = b - invphi * (b - a), a + invphi * (b - a)
    fc, fd = error(c), error(d)
    for _ in range(60):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - invphi * (b - a)
            fc = error(c)
        else:
            a, c, fc = c, d, fd
            d = a + invphi * (b - a)
            fd = error(d)
    return (a + b) / 2


def terminal_field(
    opponents_alive: int,
    week: int,
    final_week: int = 18,
    weekly_survival: float = TARGET_WEEKLY_SURVIVAL,
) -> int:
    """How many opponents you expect to still be splitting with at the end.

    The number to hand a pot-share model, and not the same as how many are
    alive today. Under deepest-splits what you divide the pot by is the field
    at *your* depth, and 249 opponents at Week 1 project to 249 * 0.73^17,
    which is under one. That difference is the whole reason a pair search
    diversifies rather than doubling up on the best team -- see the docstring
    in models/joint_pot_share.py, where getting this wrong reversed the answer.

    Floored at one. Zero opponents would mean the pot is yours whatever you
    pick, which makes every candidate score identically and is never true.
    """
    weeks_left = max(0, final_week - week)
    return max(1, round(opponents_alive * weekly_survival ** weeks_left))
