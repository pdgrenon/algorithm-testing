import json
from pathlib import Path

import pytest

from state.entries_store import (
    load_picks_for_entry,
    load_used_teams_for_entry,
    record_pick,
    save_picks_for_entry,
)


class TestPerEntryFile:
    def test_missing_file_returns_empty_list(self, tmp_path: Path):
        assert load_used_teams_for_entry("Entry A", state_file=tmp_path / "missing.json") == []
        assert load_picks_for_entry("Entry A", state_file=tmp_path / "missing.json") == []

    def test_save_then_load_roundtrip(self, tmp_path: Path):
        path = tmp_path / "used_teams_a.json"
        save_picks_for_entry("Entry A", [{"week": 1, "team": "KC"}, {"week": 2, "team": "BUF"}], state_file=path)
        assert load_used_teams_for_entry("Entry A", state_file=path) == ["KC", "BUF"]
        assert load_picks_for_entry("Entry A", state_file=path) == [
            {"week": 1, "team": "KC"},
            {"week": 2, "team": "BUF"},
        ]

    def test_saved_file_is_self_describing(self, tmp_path: Path):
        path = tmp_path / "used_teams_a.json"
        save_picks_for_entry("Entry A", [{"week": 1, "team": "KC"}], state_file=path)
        payload = json.loads(path.read_text())
        assert payload == {"entry": "Entry A", "picks": [{"week": 1, "team": "KC"}]}

    def test_reads_legacy_used_teams_format(self, tmp_path: Path):
        path = tmp_path / "used_teams_a.json"
        path.write_text(json.dumps({"entry": "Entry A", "used_teams": ["KC", "BUF"]}))
        assert load_used_teams_for_entry("Entry A", state_file=path) == ["KC", "BUF"]
        assert load_picks_for_entry("Entry A", state_file=path) == [
            {"week": None, "team": "KC"},
            {"week": None, "team": "BUF"},
        ]

    def test_picks_sorted_by_week_with_unknown_last(self, tmp_path: Path):
        path = tmp_path / "used_teams_a.json"
        save_picks_for_entry(
            "Entry A",
            [{"week": 3, "team": "SF"}, {"week": None, "team": "DAL"}, {"week": 1, "team": "KC"}],
            state_file=path,
        )
        picks = load_picks_for_entry("Entry A", state_file=path)
        assert [p["team"] for p in picks] == ["KC", "SF", "DAL"]


class TestRecordPick:
    def test_appends_new_team_with_week(self, tmp_path: Path):
        path = tmp_path / "used_teams_a.json"
        record_pick("Entry A", "KC", 1, state_file=path)
        record_pick("Entry A", "BUF", 2, state_file=path)
        assert load_used_teams_for_entry("Entry A", state_file=path) == ["KC", "BUF"]
        assert load_picks_for_entry("Entry A", state_file=path) == [
            {"week": 1, "team": "KC"},
            {"week": 2, "team": "BUF"},
        ]

    def test_recording_same_team_twice_is_idempotent(self, tmp_path: Path):
        path = tmp_path / "used_teams_a.json"
        record_pick("Entry A", "KC", 1, state_file=path)
        record_pick("Entry A", "KC", 5, state_file=path)  # different week, same team -- ignored
        assert load_picks_for_entry("Entry A", state_file=path) == [{"week": 1, "team": "KC"}]

    def test_week_can_be_none(self, tmp_path: Path):
        path = tmp_path / "used_teams_a.json"
        record_pick("Entry A", "KC", None, state_file=path)
        assert load_used_teams_for_entry("Entry A", state_file=path) == ["KC"]

    def test_unknown_entry_without_explicit_file_raises(self):
        with pytest.raises(ValueError):
            record_pick("Entry Z", "KC", 1)

    def test_entry_a_and_entry_b_files_are_independent(self, tmp_path: Path):
        path_a = tmp_path / "used_teams_a.json"
        path_b = tmp_path / "used_teams_b.json"
        record_pick("Entry A", "KC", 1, state_file=path_a)
        record_pick("Entry B", "SF", 1, state_file=path_b)
        assert load_used_teams_for_entry("Entry A", state_file=path_a) == ["KC"]
        assert load_used_teams_for_entry("Entry B", state_file=path_b) == ["SF"]
