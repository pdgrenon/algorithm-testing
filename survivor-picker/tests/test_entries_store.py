from pathlib import Path

import pytest

from state.entries_store import (
    load_used_teams_for_entry,
    record_pick,
    save_used_teams_for_entry,
)


class TestPerEntryFile:
    def test_missing_file_returns_empty_list(self, tmp_path: Path):
        assert load_used_teams_for_entry("Entry A", state_file=tmp_path / "missing.json") == []

    def test_save_then_load_roundtrip(self, tmp_path: Path):
        path = tmp_path / "used_teams_a.json"
        save_used_teams_for_entry("Entry A", ["KC", "BUF"], state_file=path)
        assert load_used_teams_for_entry("Entry A", state_file=path) == ["KC", "BUF"]

    def test_saved_file_is_self_describing(self, tmp_path: Path):
        import json

        path = tmp_path / "used_teams_a.json"
        save_used_teams_for_entry("Entry A", ["KC"], state_file=path)
        payload = json.loads(path.read_text())
        assert payload == {"entry": "Entry A", "used_teams": ["KC"]}


class TestRecordPick:
    def test_appends_new_team(self, tmp_path: Path):
        path = tmp_path / "used_teams_a.json"
        record_pick("Entry A", "KC", state_file=path)
        record_pick("Entry A", "BUF", state_file=path)
        assert load_used_teams_for_entry("Entry A", state_file=path) == ["KC", "BUF"]

    def test_recording_same_team_twice_is_idempotent(self, tmp_path: Path):
        path = tmp_path / "used_teams_a.json"
        record_pick("Entry A", "KC", state_file=path)
        record_pick("Entry A", "KC", state_file=path)
        assert load_used_teams_for_entry("Entry A", state_file=path) == ["KC"]

    def test_unknown_entry_without_explicit_file_raises(self):
        with pytest.raises(ValueError):
            record_pick("Entry Z", "KC")

    def test_entry_a_and_entry_b_files_are_independent(self, tmp_path: Path):
        path_a = tmp_path / "used_teams_a.json"
        path_b = tmp_path / "used_teams_b.json"
        record_pick("Entry A", "KC", state_file=path_a)
        record_pick("Entry B", "SF", state_file=path_b)
        assert load_used_teams_for_entry("Entry A", state_file=path_a) == ["KC"]
        assert load_used_teams_for_entry("Entry B", state_file=path_b) == ["SF"]
