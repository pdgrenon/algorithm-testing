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
from dataclasses import dataclass, field as dc_field
from typing import Dict, List, Optional, Sequence, Set, Tuple

# Sharpness of the simulated field. Lower converges on the chalk; higher
# spreads out. A $10 buy-in implies a public field, so the default leans that
# way -- but it is a guess and is the first thing to replace with real data.
# Concentration, as the share of the field landing on the most popular team on
# a typical board: casual ~47%, average ~68%, sharp ~91%.
CASUAL_TAU = 0.35
AVERAGE_TAU = 0.25
SHARP_TAU = 0.15

# How strongly a team's win probability drives the field's choice, before tau.
POPULARITY_BETA = 1.0

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


@dataclass
class Opponent:
    """One entry in the field: an inventory and how far it got."""

    entry_id: str
    used: Set[str] = dc_field(default_factory=set)
    last_week_survived: int = 0
    alive: bool = True


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def pick_weights(
    candidates: Sequence[Tuple[str, float]],
    tau: float = CASUAL_TAU,
    beta: float = POPULARITY_BETA,
) -> List[float]:
    """Multinomial-logit weights over ``(team, win_pct)`` candidates.

    Shifted by the maximum before exponentiating, which changes no ratio and
    keeps a sharp tau from overflowing.
    """
    if not candidates:
        return []
    scores = [beta * _logit(p / 100.0) / tau for _, p in candidates]
    top = max(scores)
    return [math.exp(s - top) for s in scores]


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
