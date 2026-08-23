""""Future value" of holding a team back instead of using them this week.

A survivor pool is a resource-allocation problem: each team can only be
picked once per entry, all season. Picking your strongest team in week 2
against a bad opponent can be a mistake if that same team has an even
easier matchup in week 7 -- using them now forfeits that future spot.

This module scores that trade-off with a simple decaying lookahead: look
at a team's next few scheduled games (default 6 weeks), discount each by
how far out it is, and compare the best discounted future matchup to the
team's win probability *this* week.

    future_value > 0  ->  a better spot is likely coming; consider holding
    future_value <= 0 ->  this week is about as good as it gets; use them

Weeks further out matter less, both because a bigger schedule surprise can
happen (byes, injuries, a team collapsing) and because the optimizer this
feeds should weigh certainty now over a maybe-better matchup a month away.
Decaying weekly is a deliberately simple choice for that -- it's not a
prediction that opponents get harder, just a discount on how much we trust
a matchup that far out.

── What this heuristic cannot see, and what replaces it ────────────────────

``compute_future_value`` scores one team at a time, and two things follow that
it has no way to notice.

It cannot tell that two teams are *interchangeable*. If both are the best
option in week 12, the heuristic reports a large future value for each -- but
they cannot both fill that slot, so at most one of them is genuinely worth
holding. Held apart, they look identical; held together, one is free.

And it cannot tell whether this week is survivable without the team. Holding a
team back only pays if something else covers the week they vacate, which is a
fact about the rest of the board and not about the team.

``shadow_price`` below is the object that answers both, and it is the same one
an optimiser would call a dual variable: the drop in continuation value caused
by removing a team from the inventory.

    FV(t) = V(S) - V(S \ {t})

Interchangeable teams then come out low automatically, because removing one
leaves the other to fill the slot and V barely moves. Byes and schedule
structure are handled for free, because V already knows about them. And the
answer is in the same units as whatever V is, so it is comparable across teams
rather than being a number on its own scale.

The heuristic is kept because it is what `strategy/entry_a_value.py` is -- the
cheap baseline the planning strategies are measured against -- and replacing
it in place would quietly delete the comparison.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Set, Tuple

from models.win_prob import TeamWeekWinProbability

DEFAULT_LOOKAHEAD_WEEKS = 6
DEFAULT_DECAY_RATE = 0.85  # per week beyond the current one


@dataclass
class FutureValueResult:
    team_abbreviation: str
    current_week: int
    current_week_win_pct: Optional[float]
    best_future_week: Optional[int] = None
    best_future_win_pct: Optional[float] = None  # raw, undiscounted win pct at that week
    best_future_weighted_win_pct: Optional[float] = None  # after decay
    future_value: Optional[float] = None  # best_future_weighted_win_pct - current_week_win_pct
    weekly_weighted: List[Tuple[int, Optional[float]]] = field(default_factory=list)

    @property
    def should_hold(self) -> bool:
        """True when a discounted future matchup already beats this week's."""
        return self.future_value is not None and self.future_value > 0


def _weight_for_distance(distance: int, decay_rate: float) -> float:
    """Weight for a matchup ``distance`` weeks out (1 = next week). Weight is
    1.0 at distance 1 and decays by ``decay_rate`` per additional week, so
    the next several weeks stay close to full weight and it tails off
    smoothly after that -- no hard cliff at the edge of the lookahead window.
    """
    return decay_rate ** max(0, distance - 1)


def compute_future_value(
    team_abbreviation: str,
    current_week: int,
    current_week_win_pct: Optional[float],
    remaining_schedule: List[TeamWeekWinProbability],
    lookahead_weeks: int = DEFAULT_LOOKAHEAD_WEEKS,
    decay_rate: float = DEFAULT_DECAY_RATE,
) -> FutureValueResult:
    """Score how much better a team's best upcoming matchup is than using them now.

    ``remaining_schedule`` only needs to contain entries after
    ``current_week``; anything at or before it, or beyond the lookahead
    window, is ignored. Missing win probabilities (bye weeks, no data yet)
    are skipped rather than treated as zero, so a lack of data never looks
    like a bad matchup.
    """
    result = FutureValueResult(
        team_abbreviation=team_abbreviation,
        current_week=current_week,
        current_week_win_pct=current_week_win_pct,
    )

    horizon_end = current_week + lookahead_weeks
    candidates = [
        entry
        for entry in remaining_schedule
        if entry.week is not None and current_week < entry.week <= horizon_end
    ]
    candidates.sort(key=lambda e: e.week)

    best_weighted: Optional[float] = None
    for entry in candidates:
        distance = entry.week - current_week
        weight = _weight_for_distance(distance, decay_rate)
        weighted = entry.win_pct * weight if entry.win_pct is not None else None
        result.weekly_weighted.append((entry.week, weighted))

        if weighted is None:
            continue
        if best_weighted is None or weighted > best_weighted:
            best_weighted = weighted
            result.best_future_week = entry.week
            result.best_future_win_pct = entry.win_pct
            result.best_future_weighted_win_pct = weighted

    if best_weighted is not None and current_week_win_pct is not None:
        result.future_value = best_weighted - current_week_win_pct

    return result


def shadow_price(
    value_of: Callable[[Set[str]], float],
    inventory: Set[str],
    team: str,
) -> float:
    """How much continuation value is lost by spending ``team``.

    ``value_of`` takes an inventory and returns its worth -- expected weeks
    survived, a log-product, an expected pot share, whatever the caller's
    objective is. This function does not care which, and that is the point:
    the result lands in the caller's own units and can be compared with them.

    Costs two evaluations of ``value_of``. With the sequence beam search that
    is a few milliseconds, which is why this is affordable per team; with a
    Monte Carlo objective it would not be, and the thing to do there is price
    the shadow with a cheaper V rather than with the one being optimised.

    Never negative in a well-behaved V: removing an option cannot make an
    inventory more valuable. It is not clamped, though -- a negative result
    means ``value_of`` is not monotone in its inventory, which is a bug in the
    caller worth surfacing rather than hiding.
    """
    without = set(inventory)
    without.discard(team)
    return value_of(inventory) - value_of(without)


def shadow_prices(
    value_of: Callable[[Set[str]], float],
    inventory: Set[str],
) -> Dict[str, float]:
    """``shadow_price`` for every team in the inventory, highest first.

    The full baseline is evaluated once rather than per team -- the loop below
    is |S| + 1 evaluations, not 2|S|.
    """
    base = value_of(inventory)
    out: Dict[str, float] = {}
    for team in sorted(inventory):
        without = set(inventory)
        without.discard(team)
        out[team] = base - value_of(without)
    return dict(sorted(out.items(), key=lambda kv: (-kv[1], kv[0])))


def compute_future_value_for_team(
    win_prob_table: Dict[Tuple[str, int], TeamWeekWinProbability],
    team_abbreviation: str,
    current_week: int,
    lookahead_weeks: int = DEFAULT_LOOKAHEAD_WEEKS,
    decay_rate: float = DEFAULT_DECAY_RATE,
) -> FutureValueResult:
    """Same as ``compute_future_value``, but pulls the schedule straight out of
    a season-wide table built by ``models.win_prob.build_win_probability_table``.
    """
    current_entry = win_prob_table.get((team_abbreviation, current_week))
    current_week_win_pct = current_entry.win_pct if current_entry else None

    remaining_schedule = [
        entry
        for (abbrev, week), entry in win_prob_table.items()
        if abbrev == team_abbreviation and week > current_week
    ]

    return compute_future_value(
        team_abbreviation=team_abbreviation,
        current_week=current_week,
        current_week_win_pct=current_week_win_pct,
        remaining_schedule=remaining_schedule,
        lookahead_weeks=lookahead_weeks,
        decay_rate=decay_rate,
    )
