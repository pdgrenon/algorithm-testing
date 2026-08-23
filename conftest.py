"""Suite-wide setup: the import path, and one thing the suite must not read.

── The repository's own pick log is not test data ──────────────────────────

`state/used_teams_a.json` and its sibling are a person's real season, and
`main.py weekly` and `main.py record-pick` write to them. Anything that runs
the read-only pipeline -- `report.build_weekly_report`, and so
`generate_report.py` -- loads them by default, so the suite was reading
whatever the tool had last recorded.

That is green today only because both files are committed empty. Record one
pick and `tests/test_generate_report.py` fails with a TypeError out of
`pick_history`, which has nothing to do with anything the test is about: the
pick log is no longer empty, so the history resolver runs, and it calls the
client with arguments the stub in that file does not take. "Run the tool, then
run the suite" turning CI red is the wrong way round.

So every test gets its own empty state directory. `state/entries_store.py`
reads the paths out of this dict at call time, and `config` holds the same
object, so redirecting it here redirects both -- and the suite can no longer
write to `state/` either.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest  # noqa: E402

from config import ENTRIES  # noqa: E402
from state.entries_store import USED_TEAMS_FILES  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_entry_state(tmp_path, monkeypatch):
    """Point each entry's state file at a fresh directory, per test."""
    root = tmp_path / "state"
    root.mkdir(parents=True, exist_ok=True)
    for entry in ENTRIES:
        monkeypatch.setitem(USED_TEAMS_FILES, entry, root / f"used_{entry.replace(' ', '_')}.json")
