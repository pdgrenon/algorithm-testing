"""Project-wide configuration for survivor-picker."""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Your two entries in the same private survivor pool.
ENTRIES = ["Entry A", "Entry B"]

# -- the pool ---------------------------------------------------------------
#
# Confirmed. These are not decoration: the field size is what decides how far
# you have to get, which decides how much future value is worth, and the
# payout rule is the terminal function every simulation ends on.
#
# 250 entries at $10 is a $2,500 pot, so a fair entry is worth exactly the
# buy-in and two entries carry $20 of baseline value on $20 staked. Judge the
# engine against that, never against whether it won this year.
#
# At 250 entries the winner very likely has to go the distance -- 250 * 0.73^k
# reaches 1 at about k = 17.5 -- which sits just above the ~140-165 inflection
# where a perfect season becomes necessary. See models/payout.py.
POOL_SIZE = 250
BUY_IN = 10.0
PAYOUT_RULE = "equal-split-among-survivors"

# What happens when nobody survives all 18 weeks, which is the *modal* outcome
# here rather than an edge case. See the long note in models/payout.py.
TERMINAL_RULE = "deepest-split"

# Confirmed for this pool, and the opposite of the near-universal assumption.
TIE_IS_LOSS = False

# No second lives. If this ever changes it is not a small edit: strikes add a
# dimension to the state space and change early-season risk appetite outright.
STRIKES_ALLOWED = 0
BUYBACKS = False

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
