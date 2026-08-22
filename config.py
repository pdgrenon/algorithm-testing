"""Project-wide configuration for survivor-picker."""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Your two entries in the same private survivor pool.
ENTRIES = ["Entry A", "Entry B"]

CACHE_DIR = BASE_DIR / "cache"
CACHE_TTL_HOURS = 4.0

STATE_DIR = BASE_DIR / "state"

# One used-teams file per entry, so each entry's season history is
# independent and easy to inspect/edit on its own.
USED_TEAMS_FILES = {
    "Entry A": STATE_DIR / "used_teams_a.json",
    "Entry B": STATE_DIR / "used_teams_b.json",
}

# ESPN "seasontype": 1 = preseason, 2 = regular season, 3 = postseason.
DEFAULT_SEASON_TYPE = 2
