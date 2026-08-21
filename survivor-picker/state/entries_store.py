"""Tracks which team each survivor entry has already used.

This is local state only -- survivor-picker never submits picks anywhere.
After you make your actual pick in the pool's website/app, record it here
with ``record_pick`` so future recommendations exclude that team.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List

from config import ENTRIES, ENTRIES_STATE_FILE


def load_used_teams(state_file: Path = ENTRIES_STATE_FILE) -> Dict[str, List[str]]:
    if not state_file.exists():
        return {entry: [] for entry in ENTRIES}
    with state_file.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    for entry in ENTRIES:
        data.setdefault(entry, [])
    return data


def save_used_teams(data: Dict[str, List[str]], state_file: Path = ENTRIES_STATE_FILE) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = state_file.with_suffix(".json.tmp")
    with tmp_path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
    tmp_path.replace(state_file)


def record_pick(entry: str, team_abbreviation: str, state_file: Path = ENTRIES_STATE_FILE) -> None:
    if entry not in ENTRIES:
        raise ValueError(f"Unknown entry {entry!r}; expected one of {ENTRIES}")
    data = load_used_teams(state_file)
    if team_abbreviation not in data[entry]:
        data[entry].append(team_abbreviation)
    save_used_teams(data, state_file)
