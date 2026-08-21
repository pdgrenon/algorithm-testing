"""Tracks which team each survivor entry has already used, across the season.

Each entry gets its own JSON file (``state/used_teams_a.json``,
``state/used_teams_b.json``) so their histories stay independent and are
easy to inspect or hand-edit individually.

This is local state only -- survivor-picker never submits picks anywhere.
After you make your actual pick in the pool's website/app, record it here
with ``record_pick`` so future recommendations exclude that team.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

from config import ENTRIES, USED_TEAMS_FILES


def _state_file_for(entry: str) -> Path:
    try:
        return USED_TEAMS_FILES[entry]
    except KeyError:
        raise ValueError(f"Unknown entry {entry!r}; expected one of {ENTRIES}") from None


def load_used_teams_for_entry(entry: str, state_file: Optional[Path] = None) -> List[str]:
    path = state_file or _state_file_for(entry)
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    return list(data.get("used_teams", []))


def save_used_teams_for_entry(entry: str, used_teams: List[str], state_file: Optional[Path] = None) -> None:
    path = state_file or _state_file_for(entry)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"entry": entry, "used_teams": used_teams}
    tmp_path = path.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    tmp_path.replace(path)


def record_pick(entry: str, team_abbreviation: str, state_file: Optional[Path] = None) -> None:
    used_teams = load_used_teams_for_entry(entry, state_file)
    if team_abbreviation not in used_teams:
        used_teams.append(team_abbreviation)
    save_used_teams_for_entry(entry, used_teams, state_file)


def load_used_teams() -> Dict[str, List[str]]:
    """Combined view across all entries, e.g. for the CLI's show-history."""
    return {entry: load_used_teams_for_entry(entry) for entry in ENTRIES}
