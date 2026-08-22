"""Tracks which team each survivor entry has picked, and in which week,
across the season.

Each entry gets its own JSON file (``state/used_teams_a.json``,
``state/used_teams_b.json``) so their histories stay independent and are
easy to inspect or hand-edit individually. Each file holds a list of
``{"week": <int>, "team": <abbreviation>}`` picks -- storing the week (not
just the team) is what lets ``pick_history.py`` look up whether each pick
won or lost.

This is local state only -- survivor-picker never submits picks anywhere.
After you make your actual pick in the pool's website/app, record it here
with ``record_pick`` so future recommendations exclude that team.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import ENTRIES, USED_TEAMS_FILES


def _state_file_for(entry: str) -> Path:
    try:
        return USED_TEAMS_FILES[entry]
    except KeyError:
        raise ValueError(f"Unknown entry {entry!r}; expected one of {ENTRIES}") from None


def load_picks_for_entry(entry: str, state_file: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Each entry's picks as ``[{"week": int | None, "team": str}, ...]``,
    sorted by week (unknown weeks last). Reads a legacy
    ``{"used_teams": [...]}`` file (no week info) as picks with
    ``week: None``, so older state files still load without crashing.
    """
    path = state_file or _state_file_for(entry)
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)

    if "picks" in data:
        picks = list(data["picks"])
    else:
        picks = [{"week": None, "team": team} for team in data.get("used_teams", [])]

    picks.sort(key=lambda p: (p.get("week") is None, p.get("week")))
    return picks


def save_picks_for_entry(entry: str, picks: List[Dict[str, Any]], state_file: Optional[Path] = None) -> None:
    path = state_file or _state_file_for(entry)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"entry": entry, "picks": picks}
    tmp_path = path.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    tmp_path.replace(path)


def record_pick(entry: str, team_abbreviation: str, week: Optional[int], state_file: Optional[Path] = None) -> None:
    """Record a pick for ``entry``. A team already recorded for this entry
    is left as-is (a survivor team can only be picked once, so there's
    nothing to update) -- edit the JSON file directly to fix a mistake.
    """
    picks = load_picks_for_entry(entry, state_file)
    if not any(p["team"] == team_abbreviation for p in picks):
        picks.append({"week": week, "team": team_abbreviation})
    save_picks_for_entry(entry, picks, state_file)


def load_used_teams_for_entry(entry: str, state_file: Optional[Path] = None) -> List[str]:
    return [p["team"] for p in load_picks_for_entry(entry, state_file)]


def load_used_teams() -> Dict[str, List[str]]:
    """Combined view across all entries, e.g. for the CLI's show-history."""
    return {entry: load_used_teams_for_entry(entry) for entry in ENTRIES}
