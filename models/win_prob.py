"""Clean, per-team, per-week win probabilities for the season.

``data/espn_client.py`` gives us, per game, an optional ``WinProbability``
(ESPN's own model, when they've published one) and an optional ``Odds``
(spread). Not every game has a probability yet -- ESPN sometimes doesn't
publish one until close to kickoff -- so this module normalizes both
sources into one consistent, per-team shape:

    win_pct   always on a 0-100 scale (ESPN's raw field is a 0-1 fraction)
    source    "api" | "spread_estimate" | "unknown", so downstream code
              can tell how much to trust the number

and assembles them into a ``{(team_abbreviation, week): TeamWeekWinProbability}``
table spanning as many weeks of games as you feed it (a single week, or a
whole season's worth collected week by week).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from data.models import Game

# ESPN's probabilities endpoint is fractional (0-1); everything in this
# module deals in whole percentage points (0-100) instead.
PERCENT_SCALE = 100.0

# Rough rule of thumb: ~1 point of spread is worth ~1.2 points of win
# probability around a 50% baseline. Only used when ESPN hasn't published
# a probability yet -- the real API value is always preferred.
SPREAD_POINTS_TO_WIN_PCT = 1.2
MIN_WIN_PCT = 1.0
MAX_WIN_PCT = 99.0


@dataclass
class TeamWeekWinProbability:
    team_abbreviation: str
    week: Optional[int]
    season_year: Optional[int]
    opponent_abbreviation: Optional[str]
    is_home: bool
    win_pct: Optional[float]  # 0-100, or None if no basis at all
    source: str  # "api" | "spread_estimate" | "unknown"


def estimate_win_pct_from_spread(spread: Optional[float], team_is_home: bool) -> Optional[float]:
    """Fallback win probability from the betting spread, 0-100 scale.

    ESPN's ``spread`` is signed relative to the home team (negative = home
    favored). This is intentionally simple -- it's only used when ESPN
    hasn't published a real win-probability yet.
    """
    if spread is None:
        return None
    home_favored_by = -spread
    team_favored_by = home_favored_by if team_is_home else -home_favored_by
    estimate = 50.0 + (team_favored_by * SPREAD_POINTS_TO_WIN_PCT)
    return max(MIN_WIN_PCT, min(MAX_WIN_PCT, estimate))


def resolve_team_win_probability(game: Game, team_is_home: bool) -> TeamWeekWinProbability:
    """Build a normalized ``TeamWeekWinProbability`` for one side of one game."""
    team = game.home if team_is_home else game.away
    opponent = game.away if team_is_home else game.home

    win_pct: Optional[float] = None
    source = "unknown"

    prob = game.probability
    if prob is not None:
        raw = prob.home_win_pct if team_is_home else prob.away_win_pct
        if raw is not None:
            win_pct = raw * PERCENT_SCALE
            source = "api"

    if win_pct is None:
        spread = game.odds.spread if game.odds else None
        estimate = estimate_win_pct_from_spread(spread, team_is_home)
        if estimate is not None:
            win_pct = estimate
            source = "spread_estimate"

    return TeamWeekWinProbability(
        team_abbreviation=team.abbreviation,
        week=game.week,
        season_year=game.season_year,
        opponent_abbreviation=opponent.abbreviation,
        is_home=team_is_home,
        win_pct=win_pct,
        source=source,
    )


def build_win_probability_table(
    games: List[Game],
) -> Dict[Tuple[str, int], TeamWeekWinProbability]:
    """Assemble a ``{(team_abbreviation, week): TeamWeekWinProbability}`` table.

    ``games`` can be a single week's games or a season's worth collected
    across multiple calls to the ESPN client -- each game only needs a
    valid ``week`` and at least one team abbreviation to contribute a row.
    A bye week simply produces no entry for that team/week, which is the
    correct "clean" representation for callers like ``future_value``.
    """
    table: Dict[Tuple[str, int], TeamWeekWinProbability] = {}
    for game in games:
        if game.week is None:
            continue
        for team, is_home in ((game.home, True), (game.away, False)):
            if not team.abbreviation:
                continue
            entry = resolve_team_win_probability(game, is_home)
            table[(team.abbreviation, game.week)] = entry
    return table


def get_team_win_pct(
    table: Dict[Tuple[str, int], TeamWeekWinProbability], team_abbreviation: str, week: int
) -> Optional[float]:
    """Convenience lookup; returns ``None`` for a bye week or missing data."""
    entry = table.get((team_abbreviation, week))
    return entry.win_pct if entry else None
