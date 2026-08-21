"""Project-wide configuration for survivor-picker."""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Your two entries in the same private survivor pool.
ENTRIES = ["Entry A", "Entry B"]

CACHE_DIR = BASE_DIR / "cache"
CACHE_TTL_HOURS = 4.0

STATE_DIR = BASE_DIR / "state"
ENTRIES_STATE_FILE = STATE_DIR / "entries.json"

# ESPN "seasontype": 1 = preseason, 2 = regular season, 3 = postseason.
DEFAULT_SEASON_TYPE = 2
