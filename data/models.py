"""Plain data structures for parsed ESPN NFL data.

These mirror only the fields survivor-picker actually uses. ESPN's site is an
undocumented API, so every field is Optional -- callers should not assume any
value is present.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Team:
    id: Optional[str] = None
    abbreviation: Optional[str] = None
    display_name: Optional[str] = None
    score: Optional[int] = None
    winner: Optional[bool] = None


@dataclass
class WinProbability:
    home_win_pct: Optional[float] = None
    away_win_pct: Optional[float] = None
    tie_pct: Optional[float] = None
    is_pregame: bool = True


@dataclass
class Odds:
    provider: Optional[str] = None
    details: Optional[str] = None  # e.g. "KC -6.5"
    spread: Optional[float] = None
    over_under: Optional[float] = None
    home_moneyline: Optional[int] = None
    away_moneyline: Optional[int] = None
    favorite_abbreviation: Optional[str] = None


@dataclass
class Game:
    event_id: Optional[str] = None
    competition_id: Optional[str] = None
    week: Optional[int] = None
    season_year: Optional[int] = None
    start_date: Optional[str] = None
    state: Optional[str] = None  # "pre" | "in" | "post"
    home: Team = field(default_factory=Team)
    away: Team = field(default_factory=Team)
    probability: Optional[WinProbability] = None
    odds: Optional[Odds] = None
