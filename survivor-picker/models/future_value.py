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
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

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
