"""Entry B's weekly hedge: diversify away from Entry A's game without
sacrificing too much safety.

This is the lightweight, sequential companion to ``joint_optimizer.py``: it
treats Entry A's pick (however it was decided -- e.g. ``entry_a_value.py``)
as already fixed, then finds Entry B's best team that

  * isn't from the same game as Entry A's pick, so one game's outcome can
    never eliminate both entries, and
  * clears a minimum win-probability floor (default 65%), so Entry B never
    chases diversification into an unsafe underdog.

Among the survivors it just takes the highest win probability -- no future
value weighting here, since Entry B's whole point in this module is
this-week safety, not season-long value banking.

For a true *joint* optimization that picks both entries' teams together
instead of assuming Entry A's pick is fixed first, see joint_optimizer.py.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from data.models import Game
from models.win_prob import resolve_team_win_probability
from state.entries_store import load_used_teams_for_entry

ENTRY_NAME = "Entry B"

# 0-100 scale, matching win_pct everywhere else in the project.
DEFAULT_MIN_WIN_PROB_FLOOR = 65.0


def meets_win_prob_floor(win_pct: Optional[float], floor: float) -> bool:
    return win_pct is not None and win_pct >= floor


@dataclass
class HedgeCandidate:
    team_abbreviation: str
    opponent_abbreviation: Optional[str]
    event_id: Optional[str]
    win_pct: Optional[float]  # 0-100, may be spread-estimated
    win_pct_source: str  # "api" | "spread_estimate" | "unknown"
    spread_detail: Optional[str]


@dataclass
class EntryBHedgeRecommendation:
    week: int
    pick: Optional[HedgeCandidate]
    reasoning: str
    alternatives: List[HedgeCandidate] = field(default_factory=list)
    floor_relaxed: bool = False


def _event_id_for_team(games: List[Game], team_abbreviation: str) -> Optional[str]:
    for game in games:
        if game.home.abbreviation == team_abbreviation or game.away.abbreviation == team_abbreviation:
            return game.event_id
    return None


def _build_candidates(
    current_week_games: List[Game], used_teams: List[str], exclude_event_id: Optional[str]
) -> List[HedgeCandidate]:
    candidates: List[HedgeCandidate] = []
    for game in current_week_games:
        if game.state and game.state != "pre":
            continue
        if exclude_event_id is not None and game.event_id == exclude_event_id:
            continue  # Entry A's game -- picking either side here would oppose Entry A
        spread_detail = game.odds.details if game.odds else None
        for team, opponent, is_home in ((game.home, game.away, True), (game.away, game.home, False)):
            if not team.abbreviation or team.abbreviation in used_teams:
                continue
            resolved = resolve_team_win_probability(game, is_home)
            candidates.append(
                HedgeCandidate(
                    team_abbreviation=team.abbreviation,
                    opponent_abbreviation=opponent.abbreviation,
                    event_id=game.event_id,
                    win_pct=resolved.win_pct,
                    win_pct_source=resolved.source,
                    spread_detail=spread_detail,
                )
            )
    return candidates


def rank_hedge_candidates(
    current_week_games: List[Game],
    used_teams: List[str],
    exclude_event_id: Optional[str] = None,
    min_win_prob_floor: float = DEFAULT_MIN_WIN_PROB_FLOOR,
) -> Tuple[List[HedgeCandidate], bool]:
    """Rank eligible candidates by win probability, highest first.

    Returns ``(candidates, floor_relaxed)``. ``floor_relaxed`` is True only
    when at least one candidate existed but none cleared the floor, so we
    fell back to the unfiltered ranking rather than leaving Entry B without
    a pick.
    """
    all_candidates = _build_candidates(current_week_games, used_teams, exclude_event_id)
    all_candidates.sort(key=lambda c: (c.win_pct is None, -(c.win_pct or 0)))

    above_floor = [c for c in all_candidates if meets_win_prob_floor(c.win_pct, min_win_prob_floor)]
    if above_floor:
        return above_floor, False
    return all_candidates, bool(all_candidates)


def _describe(candidate: HedgeCandidate) -> str:
    win_pct = f"{candidate.win_pct:.1f}%" if candidate.win_pct is not None else "unknown"
    basis = " (estimated from spread)" if candidate.win_pct_source == "spread_estimate" else ""
    spread = f", spread {candidate.spread_detail}" if candidate.spread_detail else ""
    return f"{candidate.team_abbreviation} vs {candidate.opponent_abbreviation or '?'} -- {win_pct} win prob{basis}{spread}"


def recommend(
    current_week_games: List[Game],
    current_week: int,
    used_teams: Optional[List[str]] = None,
    entry_a_pick_team: Optional[str] = None,
    min_win_prob_floor: float = DEFAULT_MIN_WIN_PROB_FLOOR,
) -> EntryBHedgeRecommendation:
    """Entry B's top pick for the week, hedged against Entry A's game.

    ``used_teams`` defaults to loading ``state/used_teams_b.json``.
    ``entry_a_pick_team`` is Entry A's team abbreviation for the week (from
    however you decided it, e.g. ``entry_a_value.recommend()``); pass
    ``None`` to rank Entry B without any hedging constraint.
    """
    if used_teams is None:
        used_teams = load_used_teams_for_entry(ENTRY_NAME)

    exclude_event_id = (
        _event_id_for_team(current_week_games, entry_a_pick_team) if entry_a_pick_team else None
    )

    ranked, floor_relaxed = rank_hedge_candidates(
        current_week_games, used_teams, exclude_event_id, min_win_prob_floor
    )

    if not ranked:
        return EntryBHedgeRecommendation(
            week=current_week,
            pick=None,
            reasoning="No eligible teams available this week (all used, or no game data).",
        )

    top, alternatives = ranked[0], ranked[1:]

    parts = [f"Top pick: {_describe(top)}."]
    if floor_relaxed:
        parts.append(
            f"No available team cleared the {min_win_prob_floor:.0f}% floor this week; "
            f"used the safest option available rather than leave Entry B without a pick."
        )
    else:
        parts.append(f"Clears the {min_win_prob_floor:.0f}% win-probability floor.")
    if exclude_event_id is not None:
        parts.append(f"Avoided Entry A's game ({entry_a_pick_team}) entirely, so one result can't eliminate both entries.")
    if alternatives:
        parts.append(f"Next best was {_describe(alternatives[0])}.")

    return EntryBHedgeRecommendation(
        week=current_week,
        pick=top,
        reasoning=" ".join(parts),
        alternatives=alternatives,
        floor_relaxed=floor_relaxed,
    )
