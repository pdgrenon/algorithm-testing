"""Read the pool's own pick sheet, which is the only real data about the field.

Everything the engine currently believes about opponents is a prior. This is
where that gets replaced by observation. Picks in this pool become visible
after kickoff each week, so what arrives is a growing record of what the field
*did* -- never what it is about to do.

── The shape it arrives in ─────────────────────────────────────────────────

A spreadsheet, one row per entry, one column per week, exported to CSV::

    Team Name        , Elimination Status , Week 1 Pick , Week 2 Pick , ...
    Gridiron Gang    , Alive              , KC          , Bills       , ...
    Ship of Theseus  , Out - Week 3       , Chiefs      , SF          , ...

Two things about that shape drive this module.

**"Team Name" is the entry's name, not an NFL team.** It is whatever the person
called their entry. The column heading collides with the thing the rest of this
codebase means by "team", and reading it as an NFL team would silently produce
a pool of 250 nonexistent franchises. The entry identifier is kept as
``entry_name`` throughout here for that reason.

**A column is added each week**, so nothing may hardcode eighteen. Week columns
are discovered by their headings, and a sheet with four weeks in it is a
perfectly good sheet in week four.

── Names are the hard part, and a wrong one is silent ──────────────────────

People type "KC", "Chiefs", "Kansas City" and "Kansas City Chiefs" for the same
team, and a survivor sheet is filled in by hand under time pressure. A name
that fails to resolve is loud and fixable. A name that resolves to the *wrong*
team is not: it puts an opponent on a team they never picked, which corrupts
their inventory, which corrupts every future-week popularity forecast built on
it, and nothing about the output looks wrong.

So ambiguity is **refused rather than guessed**. "LA" is not a team -- it has
been two of them since 2017 -- and neither is "NY". Those raise rather than
resolving to whichever came first in a dictionary. The four abbreviations this
codebase already documents as traps get the same care: ESPN uses WSH, LAR, LV
and JAX where much of the world writes WAS, LA, LVR and JAC.
"""
from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

from data.teams import NFL_TEAMS


class UnknownTeam(ValueError):
    """A pick that does not resolve to any NFL team."""


class AmbiguousTeam(ValueError):
    """A pick that resolves to more than one NFL team. Never guessed."""


# Full names and cities, keyed by the abbreviation this codebase uses. ESPN's
# abbreviations are not always the familiar ones -- WSH, LAR, LV and JAX are
# the four that catch people -- so the aliases below deliberately accept the
# common wrong ones and map them here.
_TEAM_NAMES: Dict[str, Tuple[str, str, str]] = {
    "ARI": ("Arizona", "Cardinals", "Arizona Cardinals"),
    "ATL": ("Atlanta", "Falcons", "Atlanta Falcons"),
    "BAL": ("Baltimore", "Ravens", "Baltimore Ravens"),
    "BUF": ("Buffalo", "Bills", "Buffalo Bills"),
    "CAR": ("Carolina", "Panthers", "Carolina Panthers"),
    "CHI": ("Chicago", "Bears", "Chicago Bears"),
    "CIN": ("Cincinnati", "Bengals", "Cincinnati Bengals"),
    "CLE": ("Cleveland", "Browns", "Cleveland Browns"),
    "DAL": ("Dallas", "Cowboys", "Dallas Cowboys"),
    "DEN": ("Denver", "Broncos", "Denver Broncos"),
    "DET": ("Detroit", "Lions", "Detroit Lions"),
    "GB": ("Green Bay", "Packers", "Green Bay Packers"),
    "HOU": ("Houston", "Texans", "Houston Texans"),
    "IND": ("Indianapolis", "Colts", "Indianapolis Colts"),
    "JAX": ("Jacksonville", "Jaguars", "Jacksonville Jaguars"),
    "KC": ("Kansas City", "Chiefs", "Kansas City Chiefs"),
    "LAC": ("Los Angeles Chargers", "Chargers", "Los Angeles Chargers"),
    "LAR": ("Los Angeles Rams", "Rams", "Los Angeles Rams"),
    "LV": ("Las Vegas", "Raiders", "Las Vegas Raiders"),
    "MIA": ("Miami", "Dolphins", "Miami Dolphins"),
    "MIN": ("Minnesota", "Vikings", "Minnesota Vikings"),
    "NE": ("New England", "Patriots", "New England Patriots"),
    "NO": ("New Orleans", "Saints", "New Orleans Saints"),
    "NYG": ("New York Giants", "Giants", "New York Giants"),
    "NYJ": ("New York Jets", "Jets", "New York Jets"),
    "PHI": ("Philadelphia", "Eagles", "Philadelphia Eagles"),
    "PIT": ("Pittsburgh", "Steelers", "Pittsburgh Steelers"),
    "SEA": ("Seattle", "Seahawks", "Seattle Seahawks"),
    "SF": ("San Francisco", "49ers", "San Francisco 49ers"),
    "TB": ("Tampa Bay", "Buccaneers", "Tampa Bay Buccaneers"),
    "TEN": ("Tennessee", "Titans", "Tennessee Titans"),
    "WSH": ("Washington", "Commanders", "Washington Commanders"),
}

# Alternates a person might reasonably type, including the abbreviations other
# sources use and franchises that have moved. Historical names are accepted
# because a long-running pool's sheet often still carries them.
_EXTRA_ALIASES: Dict[str, str] = {
    "was": "WSH", "wash": "WSH", "football team": "WSH", "redskins": "WSH",
    "la rams": "LAR", "st louis": "LAR", "st. louis": "LAR", "stl": "LAR",
    "la chargers": "LAC", "san diego": "LAC", "sd": "LAC", "sdg": "LAC",
    "lvr": "LV", "oakland": "LV", "oak": "LV", "raiders": "LV",
    "jac": "JAX", "jaguars": "JAX",
    "ne patriots": "NE", "nwe": "NE", "pats": "NE",
    "gnb": "GB", "green bay packers": "GB",
    "kan": "KC", "tam": "TB", "sfo": "SF", "nor": "NO",
    "niners": "SF", "9ers": "SF",
    "ny giants": "NYG", "g-men": "NYG",
    "ny jets": "NYJ",
    "cards": "ARI", "bucs": "TB", "jags": "JAX",
}

# Strings that name more than one team and are therefore refused. Guessing here
# is the failure this module exists to prevent.
_AMBIGUOUS: Dict[str, List[str]] = {
    "la": ["LAR", "LAC"],
    "los angeles": ["LAR", "LAC"],
    "ny": ["NYG", "NYJ"],
    "new york": ["NYG", "NYJ"],
}


def _key(value: str) -> str:
    """Lowercase, strip punctuation and collapse whitespace."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", value or "").strip().lower())


def _build_lookup() -> Dict[str, str]:
    lookup: Dict[str, str] = {}
    for abbr, (city, nickname, full) in _TEAM_NAMES.items():
        for form in (abbr, city, nickname, full):
            lookup[_key(form)] = abbr
    lookup.update({_key(k): v for k, v in _EXTRA_ALIASES.items()})
    # Never let an alias shadow an ambiguous string.
    for word in _AMBIGUOUS:
        lookup.pop(_key(word), None)
    return lookup


_LOOKUP = _build_lookup()

# Headings that identify each column. Matched on a normalised key, so
# "Elimination Status", "elimination_status" and "Status" all land.
_ENTRY_HEADINGS = ("team name", "team", "entry", "entry name", "name", "player", "owner")
_STATUS_HEADINGS = ("elimination status", "status", "eliminated", "alive", "state")
_WEEK_PATTERN = re.compile(r"^(?:week|wk|w)?\s*[_\-]?\s*(\d{1,2})\s*(?:pick|picks)?$")

# Text in the status column that means "still in". Everything else is read as
# out, because a pool sheet says "Out - Week 5" in more ways than it says
# "Alive", and treating an unrecognised status as alive is the direction that
# quietly inflates the field.
_ALIVE_WORDS = {"alive", "in", "active", "live", "yes", "y", "still in", "surviving", ""}


@dataclass
class PoolEntry:
    """One row of the sheet: an entry, its picks, and whether it is still in."""

    entry_name: str
    picks: Dict[int, str] = field(default_factory=dict)   # week -> abbreviation
    status_text: str = ""
    alive: bool = True

    @property
    def used(self) -> Set[str]:
        """Every team this entry has spent. The thing the engine actually needs."""
        return set(self.picks.values())

    def available(self, all_teams: Sequence[str] = tuple(NFL_TEAMS)) -> Set[str]:
        return set(all_teams) - self.used

    @property
    def last_week_picked(self) -> int:
        return max(self.picks) if self.picks else 0


@dataclass
class PoolSheet:
    """The whole field as read off the sheet."""

    entries: List[PoolEntry] = field(default_factory=list)
    weeks: List[int] = field(default_factory=list)
    problems: List[str] = field(default_factory=list)

    @property
    def alive(self) -> List[PoolEntry]:
        return [e for e in self.entries if e.alive]

    def popularity(self, week: int) -> Dict[str, float]:
        """What share of the field took each team in ``week``.

        Observed, not modelled -- this is the number the popularity model is
        supposed to predict, and having it for past weeks is what makes fitting
        that model against *this* pool possible rather than borrowing a
        national average.
        """
        picks = [e.picks[week] for e in self.entries if week in e.picks]
        if not picks:
            return {}
        return {t: picks.count(t) / len(picks) for t in sorted(set(picks))}


def normalize_team(raw: str) -> Optional[str]:
    """A written team name to this codebase's abbreviation.

    Returns ``None`` for a blank cell, which is an entry that has not picked
    that week rather than an error. Raises on anything that does not resolve,
    and on anything that resolves to more than one team.
    """
    key = _key(raw)
    if not key:
        return None
    if key in _AMBIGUOUS:
        raise AmbiguousTeam(
            f"{raw!r} could be {' or '.join(_AMBIGUOUS[key])} -- refusing to guess. "
            f"Write the full name."
        )
    abbr = _LOOKUP.get(key)
    if abbr is None:
        raise UnknownTeam(f"{raw!r} is not a team this reader knows.")
    return abbr


def _classify_headers(headers: Sequence[str]) -> Tuple[Optional[int], Optional[int], Dict[int, int]]:
    """(entry column, status column, {week: column}) from the header row."""
    entry_col = status_col = None
    week_cols: Dict[int, int] = {}

    for i, raw in enumerate(headers):
        key = _key(raw)
        if not key:
            continue
        match = _WEEK_PATTERN.match(key)
        if match:
            week_cols[int(match.group(1))] = i
            continue
        if status_col is None and key in _STATUS_HEADINGS:
            status_col = i
            continue
        if entry_col is None and key in _ENTRY_HEADINGS:
            entry_col = i

    # A sheet whose first column is unlabelled is still readable: the entry name
    # is whatever is left of the first week column.
    if entry_col is None and week_cols:
        first_week = min(week_cols.values())
        if first_week > 0:
            entry_col = 0
    return entry_col, status_col, week_cols


def load_pool_sheet(path: Path | str, strict: bool = False) -> PoolSheet:
    """Read a pool pick sheet exported to CSV.

    Unresolvable cells are collected into ``sheet.problems`` and skipped rather
    than raising, so one typo in row 180 does not cost you the other 249 rows.
    ``strict=True`` raises on the first one instead, which is what a test wants.
    """
    with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.reader(handle))
    if not rows:
        return PoolSheet(problems=["the sheet is empty"])

    entry_col, status_col, week_cols = _classify_headers(rows[0])
    sheet = PoolSheet(weeks=sorted(week_cols))

    if entry_col is None:
        sheet.problems.append(
            "no entry-name column found; expected a heading like 'Team Name' or 'Entry'"
        )
        return sheet
    if not week_cols:
        sheet.problems.append("no week columns found; expected headings like 'Week 1 Pick'")
        return sheet

    for line, row in enumerate(rows[1:], start=2):
        if not any(cell.strip() for cell in row):
            continue
        name = row[entry_col].strip() if entry_col < len(row) else ""
        if not name:
            sheet.problems.append(f"row {line}: no entry name; skipped")
            continue

        status = row[status_col].strip() if status_col is not None and status_col < len(row) else ""
        entry = PoolEntry(
            entry_name=name,
            status_text=status,
            alive=_key(status) in _ALIVE_WORDS,
        )

        for week, col in sorted(week_cols.items()):
            cell = row[col] if col < len(row) else ""
            try:
                team = normalize_team(cell)
            except (UnknownTeam, AmbiguousTeam) as exc:
                if strict:
                    raise
                sheet.problems.append(f"row {line} ({name}), week {week}: {exc}")
                continue
            if team is not None:
                entry.picks[week] = team

        sheet.entries.append(entry)

    sheet.problems.extend(_consistency_problems(sheet))
    return sheet


def _consistency_problems(sheet: PoolSheet) -> List[str]:
    """Things that are readable but cannot be true.

    These are not parse failures -- every cell resolved. They are the sheet
    disagreeing with itself, which is worth surfacing because the engine is
    about to treat it as ground truth about 250 people.
    """
    problems: List[str] = []
    for entry in sheet.entries:
        seen: Dict[str, int] = {}
        for week in sorted(entry.picks):
            team = entry.picks[week]
            if team in seen:
                problems.append(
                    f"{entry.entry_name}: picked {team} in both week {seen[team]} and "
                    f"week {week} -- a team can only be spent once"
                )
            else:
                seen[team] = week

        if entry.alive and entry.picks:
            missing = [w for w in sheet.weeks if w <= entry.last_week_picked and w not in entry.picks]
            if missing:
                problems.append(
                    f"{entry.entry_name}: alive, but no pick recorded for "
                    f"week{'s' if len(missing) > 1 else ''} {missing}"
                )
    return problems


def used_teams_by_entry(sheet: PoolSheet) -> Dict[str, Set[str]]:
    """The inventory table: the thing every downstream calculation needs.

    Exact rather than estimated, which is what makes visible picks worth
    having. Forecasting what a field will do next week stops being extrapolation
    from a national average and becomes a question about the teams these
    specific people can still legally pick.
    """
    return {e.entry_name: e.used for e in sheet.entries}
