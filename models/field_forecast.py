"""How a survivor field distributes itself over a week's board.

This is the popularity model, and it lives here rather than in
``scripts/field.py`` because two very different things now need it:

* ``scripts/field.py`` **generates** opponents with it, which is what makes
  ``--pot-share`` mean anything.
* ``strategy/leverage.py`` **reads** it, to forecast what the rest of the pool
  is about to do from what they have already spent.

It was in ``scripts/`` and had to move, because ``scripts/`` is where anything
that *may* fetch lives and the engine is forbidden from importing it. Moving it
rather than copying it is the whole point: two copies of a scoring function
drift, and this one is load-bearing in both directions — the generator and the
strategy reading it have to agree, or a measured edge is an artefact of the two
disagreeing.

Nothing here fetches, reads a clock, or draws a random number.

── The model ───────────────────────────────────────────────────────────────

A multinomial logit over the teams still in an entry's inventory:

    weight(t) ∝ exp( beta * logit(p_t) / tau )

`tau` is the **concentration**: as it falls the field converges on the single
best team, as it rises it spreads out. It is the quantity real popularity data
measures — what share of the field lands on the most popular pick — and
``scripts/field.py``'s ``fit_tau`` turns an observed week into the tau that
produced it.

── Why inventories, and not one distribution over the board ────────────────

Because two entries with different teams left do not face the same choice, and
by Week 10 that difference is most of what determines popularity. Computed once
over the whole board the chalk holds 40% every week; in fact the entries that
already spent it are somewhere else. Inventory exhaustion is the mechanism that
makes a public field die at the historical rate without being modelled as
careless, and it is the mechanism a strategy can read.
"""

from __future__ import annotations

import math
from functools import lru_cache
from typing import Dict, List, Mapping, Sequence, Set, Tuple

# The concentration ladder. `fit_tau` turns an observed Week 1 into the tau
# that produced it; until a real sheet arrives these are the prior.
CASUAL_TAU = 0.35
AVERAGE_TAU = 0.25
SHARP_TAU = 0.15

# How strongly a team's win probability drives the field's choice, before tau.
POPULARITY_BETA = 1.0


@lru_cache(maxsize=8192)
def _logit(p: float) -> float:
    """Memoised, and the memo changes no arithmetic at all.

    Every opponent alive in a week scores the same board, so this is called
    with the same handful of win probabilities 248 times over -- once per
    surviving entry -- and a log is the most expensive thing in the loop.
    Same float in, same float out, so the simulation is bit-for-bit what it
    was; there is a test.
    """
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


def popularity_from_inventories(
    inventories: Sequence[Set[str]],
    candidates: Sequence[Tuple[str, float]],
    tau: float = CASUAL_TAU,
    beta: float = POPULARITY_BETA,
) -> Dict[str, float]:
    """What fraction of the surviving field lands on each team this week.

    Averaged over each opponent's *own* inventory rather than computed once
    over the whole board, because two entries with different teams left do not
    face the same choice -- and by Week 10 that difference is most of what
    determines popularity. Computing it once over the full board would say the
    chalk holds 40% every week, when in fact the entries that already spent it
    are somewhere else.

    Takes the inventories directly rather than a pool, because the field's
    trajectory does not depend on your picks and is therefore simulated once
    and shared across every strategy compared against it.

    In the harness the number is **exact** rather than forecast: the same
    weights generate the opponents' picks, so a strategy reading this is being
    handed the true generating distribution. That is deliberate, and it is what
    makes a policy comparison there a policy comparison -- any gap between two
    strategies is the policy, not one of them having a better popularity model.
    Against the real pool this same shape is an estimate, `--robustness`
    measures what that costs, and the gap will be smaller.
    """
    # Opponents with the same teams spent face the same choice, so the weights
    # are computed once per *distinct* inventory rather than once per entry.
    # In Week 1 that is 248 entries sharing one empty inventory, and it stays
    # worth doing well past that: entries that took the same chalk are still
    # interchangeable in Week 6.
    #
    # The accumulation loop below is deliberately untouched. Multiplying one
    # opponent's contribution by how many share it would be faster still and
    # would not be bit-identical -- repeated addition and multiplication differ
    # in the last place, and the result feeds an integer apportionment where a
    # boundary case could flip a whole entry. Looking the vector up instead
    # keeps every addition in the same order with the same values, which is
    # what 1,200 random forecasts were checked against.
    by_inventory: Dict[frozenset, Tuple[List[Tuple[str, float]], List[float], float]] = {}
    shares: Dict[str, float] = {}
    counted = 0
    for used in inventories:
        key = frozenset(used)
        cached = by_inventory.get(key)
        if cached is None:
            mine = [c for c in candidates if c[0] not in used]
            weights = pick_weights(mine, tau, beta)
            cached = (mine, weights, sum(weights))
            by_inventory[key] = cached
        mine, weights, total = cached
        if total <= 0.0:
            continue
        counted += 1
        for (team, _), weight in zip(mine, weights):
            shares[team] = shares.get(team, 0.0) + weight / total
    if not counted:
        return {}
    return {team: share / counted for team, share in shares.items()}


def forecast_for_pool(
    inventories: Mapping[str, Sequence[str]],
    candidates: Sequence[Tuple[str, float]],
    tau: float = CASUAL_TAU,
    beta: float = POPULARITY_BETA,
) -> Dict[str, float]:
    """The same forecast, from ``/api/pool``'s inventory table.

    The shape the real sheet arrives in is ``{entry name: [teams spent]}`` --
    exact, per surviving entry, and the observed counterpart of what
    ``scripts/field.py`` invents. This adapter is the whole join between the
    two, so a strategy reads one function whether the field is simulated or
    read off a spreadsheet.
    """
    return popularity_from_inventories(
        [set(used) for used in inventories.values()], candidates, tau, beta,
    )
