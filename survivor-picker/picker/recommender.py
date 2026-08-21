"""Turns this week's parsed ESPN games into ranked survivor-pool pick candidates.

This module only produces output for a human to read -- it never submits
anything to the pool. It is deliberately simple: rank each team not yet
used by an entry by its estimated win probability (falling back to the
betting spread when ESPN's probability endpoint has no data yet), and
flag when both entries would end up recommended the same team so you can
diversify if you want to.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional

from data.models import Game
from models.win_prob import resolve_team_win_probability


@dataclass
class PickCandidate:
    team_abbreviation: str
    team_name: Optional[str]
    opponent_abbreviation: Optional[str]
    win_pct: Optional[float]  # 0-100, may be estimated
    win_pct_is_estimated: bool
    spread_detail: Optional[str]
    event_id: Optional[str]


def _candidates_for_game(game: Game) -> List[PickCandidate]:
    candidates = []
    spread_detail = game.odds.details if game.odds else None

    for team, opponent, is_home in (
        (game.home, game.away, True),
        (game.away, game.home, False),
    ):
        if not team.abbreviation:
            continue
        # Always 0-100 scale here, whether it came from ESPN's own
        # probability field or a spread-derived fallback -- see
        # models/win_prob.py for the blending logic.
        resolved = resolve_team_win_probability(game, is_home)
        candidates.append(
            PickCandidate(
                team_abbreviation=team.abbreviation,
                team_name=team.display_name,
                opponent_abbreviation=opponent.abbreviation,
                win_pct=resolved.win_pct,
                win_pct_is_estimated=resolved.source == "spread_estimate",
                spread_detail=spread_detail,
                event_id=game.event_id,
            )
        )
    return candidates


def rank_candidates(games: List[Game], used_teams: List[str]) -> List[PickCandidate]:
    """Rank all not-yet-used teams playing this week by estimated win probability.

    Games/teams with no probability data at all (win_pct is None) sort last,
    since we have no basis to recommend them over a team we can score.
    """
    all_candidates: List[PickCandidate] = []
    for game in games:
        if game.state and game.state != "pre":
            # Already started/finished games aren't legitimate picks for this week.
            continue
        all_candidates.extend(_candidates_for_game(game))

    available = [c for c in all_candidates if c.team_abbreviation not in used_teams]
    available.sort(key=lambda c: (c.win_pct is None, -(c.win_pct or 0)))
    return available


def recommend_for_entries(
    games: List[Game], used_teams_by_entry: Dict[str, List[str]], top_n: int = 5
) -> Dict[str, List[PickCandidate]]:
    """Return the top ``top_n`` ranked candidates for each entry.

    Each entry is ranked independently against its own used-teams history,
    since Entry A and Entry B can have burned different teams in past weeks.
    """
    return {
        entry: rank_candidates(games, used_teams)[:top_n]
        for entry, used_teams in used_teams_by_entry.items()
    }


def find_conflicts(recommendations: Dict[str, List[PickCandidate]]) -> Optional[str]:
    """If every entry's #1 recommendation is the same team, return that team's
    abbreviation as a heads-up to diversify; otherwise return None.
    """
    top_picks = {
        entry: candidates[0].team_abbreviation
        for entry, candidates in recommendations.items()
        if candidates
    }
    values = list(top_picks.values())
    if len(values) > 1 and len(set(values)) == 1:
        return values[0]
    return None
