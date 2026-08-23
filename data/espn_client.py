"""Client for ESPN's unofficial NFL API.

ESPN does not publish or support these endpoints, so this client is
deliberately conservative:

  * Every response is cached to a local JSON file, keyed per NFL week, and
    only re-fetched after ``cache_ttl_hours`` have passed (default 4h) --
    this keeps request volume low.
  * Network calls retry on transient failures (connection errors, 429s,
    5xx) with exponential backoff via ``urllib3.Retry``.
  * If a live fetch fails after retries, the client falls back to whatever
    is on disk (even if stale) rather than raising, so a recommendation run
    degrades gracefully instead of crashing.
  * All JSON parsing goes through ``_safe_get`` so a missing/renamed field
    in ESPN's response produces ``None`` instead of a ``KeyError``.

Endpoints used:
  * Scoreboard (schedule + live scores):
      https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
  * Win probability:
      https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{event_id}/competitions/{competition_id}/probabilities
  * Odds / spread:
      https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/{event_id}/competitions/{competition_id}/odds
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from data.models import Game, Odds, Team, WinProbability

logger = logging.getLogger(__name__)

SITE_API_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
CORE_API_BASE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"

DEFAULT_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"
DEFAULT_CACHE_TTL_HOURS = 4.0
DEFAULT_TIMEOUT_SECONDS = 10
DEFAULT_MIN_REQUEST_INTERVAL = 0.5  # seconds between live HTTP calls, be a good citizen

USER_AGENT = "survivor-picker/0.1 (personal weekly-pick tool; contact: private use)"


def _safe_get(obj: Any, *path: Any, default: Any = None) -> Any:
    """Walk nested dict/list ``obj`` along ``path``, returning ``default`` on any miss."""
    current = obj
    for key in path:
        if current is None:
            return default
        try:
            current = current[key]
        except (KeyError, IndexError, TypeError):
            return default
    return current if current is not None else default


def _sanitize_key(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", key)


class JSONCache:
    """Per-key JSON file cache with a time-to-live.

    Files are stored as ``{root}/{sanitized_key}.json`` with an envelope of
    ``{"cached_at": ISO8601, "data": <payload>}`` so we can check age without
    touching the filesystem's mtime (more portable across archive/copy).
    """

    def __init__(self, root: Path, ttl_hours: float) -> None:
        self.root = root
        self.ttl_hours = ttl_hours
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        return self.root / f"{_sanitize_key(key)}.json"

    def read(self, key: str, allow_stale: bool = False) -> Optional[Any]:
        path = self._path(key)
        if not path.exists():
            return None
        try:
            with path.open("r", encoding="utf-8") as fh:
                envelope = json.load(fh)
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Cache file %s unreadable (%s); ignoring", path, exc)
            return None

        cached_at_raw = envelope.get("cached_at")
        try:
            cached_at = datetime.fromisoformat(cached_at_raw)
        except (TypeError, ValueError):
            return None

        # `write` always stamps UTC with an offset, so a naive timestamp came
        # from somewhere else -- a hand-edited file, or an older copy of this
        # tool. Read it as UTC rather than subtracting it: mixing naive and
        # aware raises TypeError, and it raised it here, out of a class whose
        # whole posture is that a bad cache file degrades to a re-fetch.
        if cached_at.tzinfo is None:
            cached_at = cached_at.replace(tzinfo=timezone.utc)

        age_hours = (datetime.now(timezone.utc) - cached_at).total_seconds() / 3600.0
        if age_hours <= self.ttl_hours or allow_stale:
            return envelope.get("data")
        return None

    def write(self, key: str, data: Any) -> None:
        path = self._path(key)
        envelope = {"cached_at": datetime.now(timezone.utc).isoformat(), "data": data}
        tmp_path = path.with_suffix(".json.tmp")
        with tmp_path.open("w", encoding="utf-8") as fh:
            json.dump(envelope, fh)
        tmp_path.replace(path)


class ESPNClient:
    """Fetches NFL schedule/score, win-probability, and odds data from ESPN.

    Parameters
    ----------
    cache_dir:
        Directory for the per-week JSON cache. Defaults to ``cache/`` at the repo root.
    cache_ttl_hours:
        How long a cached response is considered fresh before a re-fetch is
        attempted. Keep this at a few hours (not minutes) -- these endpoints
        are unofficial and we want to minimize request volume.
    min_request_interval:
        Minimum seconds to wait between outbound HTTP requests, as a simple
        self-imposed rate limit.
    """

    def __init__(
        self,
        cache_dir: Path | str = DEFAULT_CACHE_DIR,
        cache_ttl_hours: float = DEFAULT_CACHE_TTL_HOURS,
        min_request_interval: float = DEFAULT_MIN_REQUEST_INTERVAL,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
        session: Optional[requests.Session] = None,
    ) -> None:
        self.cache = JSONCache(Path(cache_dir), cache_ttl_hours)
        self.min_request_interval = min_request_interval
        self.timeout_seconds = timeout_seconds
        self._last_request_at = 0.0
        self.session = session or self._build_session()

    @staticmethod
    def _build_session() -> requests.Session:
        session = requests.Session()
        session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
        retry = Retry(
            total=3,
            backoff_factor=1.5,  # 0s, 1.5s, 3s, ... between retries
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET"],
            respect_retry_after_header=True,
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        return session

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request_at
        wait = self.min_request_interval - elapsed
        if wait > 0:
            time.sleep(wait)

    def _fetch_json(self, url: str, params: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        self._throttle()
        try:
            response = self.session.get(url, params=params, timeout=self.timeout_seconds)
            response.raise_for_status()
            return response.json()
        except requests.RequestException as exc:
            logger.warning("ESPN request failed for %s (%s): %s", url, params, exc)
            return None
        except ValueError as exc:  # invalid JSON body
            logger.warning("ESPN returned non-JSON body for %s: %s", url, exc)
            return None
        finally:
            # Stamped whether or not the request came back. It was set only on
            # the success path, so a run that started failing stopped waiting
            # between attempts -- the self-imposed rate limit switched itself
            # off at exactly the moment an unofficial endpoint was least
            # pleased to hear from us.
            self._last_request_at = time.monotonic()

    def _get_cached_or_fetch(
        self, cache_key: str, url: str, params: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        cached = self.cache.read(cache_key)
        if cached is not None:
            logger.debug("Cache hit for %s", cache_key)
            return cached

        fresh = self._fetch_json(url, params)
        if fresh is not None:
            self.cache.write(cache_key, fresh)
            return fresh

        stale = self.cache.read(cache_key, allow_stale=True)
        if stale is not None:
            logger.warning("Using stale cache for %s after fetch failure", cache_key)
            return stale

        logger.error("No data available for %s (fetch failed, no cache)", cache_key)
        return None

    # -- Raw endpoints -----------------------------------------------------

    def get_scoreboard_raw(
        self,
        week: Optional[int] = None,
        year: Optional[int] = None,
        seasontype: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        """Fetch the scoreboard (schedule + scores). No args = current week."""
        params: Dict[str, Any] = {}
        if week is not None:
            params["week"] = week
        if year is not None:
            params["dates"] = year
        if seasontype is not None:
            params["seasontype"] = seasontype

        cache_key = "scoreboard_current" if not params else (
            f"scoreboard_y{year}_st{seasontype}_w{week}"
        )
        return self._get_cached_or_fetch(cache_key, f"{SITE_API_BASE}/scoreboard", params or None)

    def get_probabilities_raw(self, event_id: str, competition_id: str) -> Optional[Dict[str, Any]]:
        url = (
            f"{CORE_API_BASE}/events/{event_id}/competitions/{competition_id}/probabilities"
        )
        cache_key = f"probabilities_{event_id}_{competition_id}"
        return self._get_cached_or_fetch(cache_key, url, {"limit": 1})

    def get_odds_raw(self, event_id: str, competition_id: str) -> Optional[Dict[str, Any]]:
        url = f"{CORE_API_BASE}/events/{event_id}/competitions/{competition_id}/odds"
        cache_key = f"odds_{event_id}_{competition_id}"
        return self._get_cached_or_fetch(cache_key, url)

    # -- Parsed helpers ------------------------------------------------------

    @staticmethod
    def _parse_team(competitor: Dict[str, Any]) -> Team:
        team_block = _safe_get(competitor, "team", default={})
        score_raw = _safe_get(competitor, "score")
        score = None
        if score_raw is not None:
            try:
                score = int(score_raw)
            except (TypeError, ValueError):
                score = None
        return Team(
            id=_safe_get(team_block, "id"),
            abbreviation=_safe_get(team_block, "abbreviation"),
            display_name=_safe_get(team_block, "displayName"),
            score=score,
            winner=_safe_get(competitor, "winner"),
        )

    def parse_games(self, scoreboard_json: Dict[str, Any]) -> List[Game]:
        """Parse the scoreboard payload into a list of ``Game`` (no probability/odds yet)."""
        games: List[Game] = []
        events = _safe_get(scoreboard_json, "events", default=[]) or []
        week_number = _safe_get(scoreboard_json, "week", "number")
        season_year = _safe_get(scoreboard_json, "season", "year")

        for event in events:
            competitions = _safe_get(event, "competitions", default=[]) or []
            competition = competitions[0] if competitions else {}
            competitors = _safe_get(competition, "competitors", default=[]) or []

            home_raw = next((c for c in competitors if _safe_get(c, "homeAway") == "home"), None)
            away_raw = next((c for c in competitors if _safe_get(c, "homeAway") == "away"), None)

            games.append(
                Game(
                    event_id=_safe_get(event, "id"),
                    competition_id=_safe_get(competition, "id", default=_safe_get(event, "id")),
                    week=week_number,
                    season_year=season_year,
                    start_date=_safe_get(event, "date"),
                    state=_safe_get(event, "status", "type", "state"),
                    home=self._parse_team(home_raw) if home_raw else Team(),
                    away=self._parse_team(away_raw) if away_raw else Team(),
                )
            )
        return games

    @staticmethod
    def parse_probability(probabilities_json: Optional[Dict[str, Any]]) -> Optional[WinProbability]:
        if not probabilities_json:
            return None
        items = _safe_get(probabilities_json, "items", default=[]) or []
        if not items:
            return None
        # First item is the pregame estimate; ESPN appends one item per play
        # as the game progresses, so items[0] is what we want pre-kickoff.
        first = items[0]
        return WinProbability(
            home_win_pct=_safe_get(first, "homeWinPercentage"),
            away_win_pct=_safe_get(first, "awayWinPercentage"),
            tie_pct=_safe_get(first, "tiePercentage"),
            is_pregame=_safe_get(first, "playId") in (None, 0),
        )

    @staticmethod
    def parse_odds(odds_json: Optional[Dict[str, Any]]) -> Optional[Odds]:
        if not odds_json:
            return None
        items = _safe_get(odds_json, "items", default=[]) or []
        if not items:
            return None
        # Prefer the first provider ESPN lists (typically their primary book).
        first = items[0]

        def moneyline(side: str) -> Optional[int]:
            value = _safe_get(first, f"{side}TeamOdds", "moneyLine")
            try:
                return int(value) if value is not None else None
            except (TypeError, ValueError):
                return None

        favorite_abbreviation = None
        if _safe_get(first, "homeTeamOdds", "favorite"):
            favorite_abbreviation = _safe_get(first, "homeTeamOdds", "team", "abbreviation")
        elif _safe_get(first, "awayTeamOdds", "favorite"):
            favorite_abbreviation = _safe_get(first, "awayTeamOdds", "team", "abbreviation")

        return Odds(
            provider=_safe_get(first, "provider", "name"),
            details=_safe_get(first, "details"),
            spread=_safe_get(first, "spread"),
            over_under=_safe_get(first, "overUnder"),
            home_moneyline=moneyline("home"),
            away_moneyline=moneyline("away"),
            favorite_abbreviation=favorite_abbreviation,
        )

    # -- High-level API --------------------------------------------------

    def get_week_games(
        self,
        week: Optional[int] = None,
        year: Optional[int] = None,
        seasontype: Optional[int] = None,
        include_probability: bool = True,
        include_odds: bool = True,
    ) -> List[Game]:
        """Return fully-parsed games for a week (default: current week), enriched
        with win probability and odds where available. Any single missing field
        or failed sub-fetch degrades gracefully rather than aborting the batch.
        """
        scoreboard = self.get_scoreboard_raw(week=week, year=year, seasontype=seasontype)
        if not scoreboard:
            logger.error("Could not obtain scoreboard data; returning no games")
            return []

        games = self.parse_games(scoreboard)

        for game in games:
            if not game.event_id or not game.competition_id:
                continue
            if include_probability:
                try:
                    prob_raw = self.get_probabilities_raw(game.event_id, game.competition_id)
                    game.probability = self.parse_probability(prob_raw)
                except Exception:  # defensive: never let one game break the batch
                    logger.exception("Failed to parse probability for event %s", game.event_id)
            if include_odds:
                try:
                    odds_raw = self.get_odds_raw(game.event_id, game.competition_id)
                    game.odds = self.parse_odds(odds_raw)
                except Exception:
                    logger.exception("Failed to parse odds for event %s", game.event_id)

        return games


def games_to_json_serializable(games: List[Game]) -> List[Dict[str, Any]]:
    """Convenience for printing/dumping ``Game`` objects (e.g. in the CLI)."""
    return [asdict(g) for g in games]
