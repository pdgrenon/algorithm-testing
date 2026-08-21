"""Resolves each entry's recorded picks against ESPN's actual results, so
the report can show a week-by-week win/loss history -- not just which
teams are burned.

Read-only, like report.py: this never writes state, it only looks up
what already happened for picks that are already recorded.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional

from config import DEFAULT_SEASON_TYPE
from data.espn_client import ESPNClient
from state.entries_store import load_picks_for_entry
from strategy.joint_optimizer import ENTRY_A_NAME, ENTRY_B_NAME


@dataclass
class PickResult:
    week: Optional[int]
    team: str
    opponent: Optional[str]
    team_score: Optional[int]
    opponent_score: Optional[int]
    result: str  # "win" | "loss" | "tie" | "pending" | "unknown"


@dataclass
class HistoryRow:
    week: int
    entry_a: Optional[PickResult]
    entry_b: Optional[PickResult]


def _resolve_pick_result(client: ESPNClient, week: Optional[int], team: str) -> PickResult:
    if week is None:
        return PickResult(week=None, team=team, opponent=None, team_score=None, opponent_score=None, result="unknown")

    games = client.get_week_games(
        week=week, seasontype=DEFAULT_SEASON_TYPE, include_probability=False, include_odds=False
    )
    for game in games:
        for mine, theirs in ((game.home, game.away), (game.away, game.home)):
            if mine.abbreviation != team:
                continue
            if game.state != "post":
                return PickResult(week, team, theirs.abbreviation, mine.score, theirs.score, "pending")
            if mine.score is not None and theirs.score is not None and mine.score == theirs.score:
                result = "tie"
            elif mine.winner is True:
                result = "win"
            elif mine.winner is False:
                result = "loss"
            else:
                result = "unknown"
            return PickResult(week, team, theirs.abbreviation, mine.score, theirs.score, result)

    return PickResult(week=week, team=team, opponent=None, team_score=None, opponent_score=None, result="unknown")


def build_pick_history(client: ESPNClient, entry: str) -> List[PickResult]:
    """Every recorded pick for ``entry``, resolved to a result, sorted by week."""
    picks = load_picks_for_entry(entry)
    return [_resolve_pick_result(client, p.get("week"), p["team"]) for p in picks]


RESULT_LABELS = {"win": "W", "loss": "L", "tie": "T", "pending": "Pending", "unknown": "?"}


def format_result_text(pr: Optional[PickResult]) -> str:
    """A one-line, plain-text rendering of a single pick's result, e.g.
    ``KC W 27-20 vs DEN``. Used by both report.py's text renderer and
    main.py's `show-history` command so the two never drift apart.
    """
    if pr is None:
        return "-"
    label = RESULT_LABELS.get(pr.result, "?")
    score = ""
    if pr.result in ("win", "loss", "tie") and pr.team_score is not None and pr.opponent_score is not None:
        score = f" {pr.team_score}-{pr.opponent_score}"
    opponent = f" vs {pr.opponent}" if pr.opponent else ""
    return f"{pr.team} {label}{score}{opponent}"


def build_combined_pick_history(client: ESPNClient) -> List[HistoryRow]:
    """One row per week either entry has a recorded pick, sorted by week.
    Picks with no known week (legacy data) are excluded -- there's no week
    to put them in a row under.
    """
    history_a = {r.week: r for r in build_pick_history(client, ENTRY_A_NAME) if r.week is not None}
    history_b = {r.week: r for r in build_pick_history(client, ENTRY_B_NAME) if r.week is not None}
    weeks = sorted(set(history_a) | set(history_b))
    return [HistoryRow(week=week, entry_a=history_a.get(week), entry_b=history_b.get(week)) for week in weeks]
