import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests

from data.espn_client import ESPNClient, JSONCache

SAMPLE_SCOREBOARD = {
    "week": {"number": 3},
    "season": {"year": 2026},
    "events": [
        {
            "id": "401547439",
            "date": "2026-09-21T17:00Z",
            "status": {"type": {"state": "pre"}},
            "competitions": [
                {
                    "id": "401547439",
                    "competitors": [
                        {
                            "homeAway": "home",
                            "score": "0",
                            "team": {"id": "12", "abbreviation": "KC", "displayName": "Kansas City Chiefs"},
                        },
                        {
                            "homeAway": "away",
                            "score": "0",
                            "team": {"id": "8", "abbreviation": "DEN", "displayName": "Denver Broncos"},
                        },
                    ],
                }
            ],
        },
        # A malformed/incomplete event to prove parsing degrades gracefully.
        {"id": "401547999", "competitions": [{"id": "401547999", "competitors": []}]},
    ],
}

SAMPLE_PROBABILITIES = {
    "items": [
        {"playId": None, "homeWinPercentage": 0.78, "awayWinPercentage": 0.22, "tiePercentage": 0.0}
    ]
}

SAMPLE_ODDS = {
    "items": [
        {
            "provider": {"name": "ESPN BET"},
            "details": "KC -6.5",
            "spread": -6.5,
            "overUnder": 45.5,
            "homeTeamOdds": {"moneyLine": -280, "favorite": True, "team": {"abbreviation": "KC"}},
            "awayTeamOdds": {"moneyLine": 230, "favorite": False, "team": {"abbreviation": "DEN"}},
        }
    ]
}


def _mock_response(payload):
    resp = MagicMock()
    resp.json.return_value = payload
    resp.raise_for_status.return_value = None
    return resp


class TestJSONCache:
    def test_write_then_read_roundtrip(self, tmp_path: Path):
        cache = JSONCache(tmp_path, ttl_hours=1)
        cache.write("mykey", {"a": 1})
        assert cache.read("mykey") == {"a": 1}

    def test_expired_entry_not_returned_by_default(self, tmp_path: Path):
        cache = JSONCache(tmp_path, ttl_hours=1)
        path = tmp_path / "mykey.json"
        old_time = (datetime.now(timezone.utc) - timedelta(hours=5)).isoformat()
        path.write_text(json.dumps({"cached_at": old_time, "data": {"a": 1}}))
        assert cache.read("mykey") is None

    def test_expired_entry_returned_when_stale_allowed(self, tmp_path: Path):
        cache = JSONCache(tmp_path, ttl_hours=1)
        path = tmp_path / "mykey.json"
        old_time = (datetime.now(timezone.utc) - timedelta(hours=5)).isoformat()
        path.write_text(json.dumps({"cached_at": old_time, "data": {"a": 1}}))
        assert cache.read("mykey", allow_stale=True) == {"a": 1}

    def test_missing_key_returns_none(self, tmp_path: Path):
        cache = JSONCache(tmp_path, ttl_hours=1)
        assert cache.read("nope") is None

    def test_a_naive_timestamp_is_read_as_utc_rather_than_raising(self, tmp_path: Path):
        """A hand-edited cache file must not take the run down with it.

        `write` stamps an offset, so a naive timestamp came from somewhere
        else -- somebody editing the file, or an older copy of this tool.
        Subtracting it from an aware `now` raises TypeError, and it did:
        uncaught, out of the one class whose whole posture is that a bad cache
        file degrades to a re-fetch.
        """
        cache = JSONCache(tmp_path, ttl_hours=4)
        naive = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
        (tmp_path / "fresh.json").write_text(json.dumps({"cached_at": naive, "data": {"a": 1}}))
        assert cache.read("fresh") == {"a": 1}

    def test_a_naive_timestamp_still_expires(self, tmp_path: Path):
        # Reading it as UTC rather than ignoring the age: a naive stamp must
        # not turn into a cache entry that never goes stale.
        cache = JSONCache(tmp_path, ttl_hours=4)
        naive = (datetime.now(timezone.utc) - timedelta(hours=9)).replace(tzinfo=None).isoformat()
        (tmp_path / "old.json").write_text(json.dumps({"cached_at": naive, "data": {"a": 1}}))
        assert cache.read("old") is None
        assert cache.read("old", allow_stale=True) == {"a": 1}

    def test_an_unparseable_timestamp_is_a_miss_not_a_crash(self, tmp_path: Path):
        cache = JSONCache(tmp_path, ttl_hours=1)
        (tmp_path / "bad.json").write_text(json.dumps({"cached_at": "whenever", "data": 1}))
        assert cache.read("bad") is None


class TestESPNClientCaching:
    def test_second_call_within_ttl_uses_cache_not_network(self, tmp_path: Path):
        client = ESPNClient(cache_dir=tmp_path, cache_ttl_hours=1, min_request_interval=0)
        client.session.get = MagicMock(return_value=_mock_response(SAMPLE_SCOREBOARD))

        first = client.get_scoreboard_raw()
        second = client.get_scoreboard_raw()

        assert first == SAMPLE_SCOREBOARD
        assert second == SAMPLE_SCOREBOARD
        assert client.session.get.call_count == 1

    def test_falls_back_to_stale_cache_on_fetch_failure(self, tmp_path: Path):
        client = ESPNClient(cache_dir=tmp_path, cache_ttl_hours=0, min_request_interval=0)
        client.session.get = MagicMock(return_value=_mock_response(SAMPLE_SCOREBOARD))
        first = client.get_scoreboard_raw()
        assert first == SAMPLE_SCOREBOARD

        client.session.get = MagicMock(side_effect=requests.ConnectionError("network down"))
        second = client.get_scoreboard_raw()
        assert second == SAMPLE_SCOREBOARD  # served from stale cache, no exception raised

    def test_no_cache_and_fetch_failure_returns_none(self, tmp_path: Path):
        client = ESPNClient(cache_dir=tmp_path, cache_ttl_hours=1, min_request_interval=0)
        client.session.get = MagicMock(side_effect=requests.ConnectionError("network down"))
        assert client.get_scoreboard_raw() is None


class TestParsing:
    def test_parse_games_handles_missing_fields_gracefully(self):
        client = ESPNClient(cache_dir=Path("/tmp/unused-cache"), min_request_interval=0)
        games = client.parse_games(SAMPLE_SCOREBOARD)

        assert len(games) == 2
        good, malformed = games
        assert good.home.abbreviation == "KC"
        assert good.away.abbreviation == "DEN"
        assert good.week == 3
        assert good.season_year == 2026

        # Malformed event should not raise -- just come back mostly empty.
        assert malformed.event_id == "401547999"
        assert malformed.home.abbreviation is None
        assert malformed.away.abbreviation is None

    def test_parse_probability(self):
        prob = ESPNClient.parse_probability(SAMPLE_PROBABILITIES)
        assert prob.home_win_pct == 0.78
        assert prob.away_win_pct == 0.22

    def test_parse_probability_handles_missing_data(self):
        assert ESPNClient.parse_probability(None) is None
        assert ESPNClient.parse_probability({"items": []}) is None
        assert ESPNClient.parse_probability({"items": [{}]}).home_win_pct is None

    def test_parse_odds(self):
        odds = ESPNClient.parse_odds(SAMPLE_ODDS)
        assert odds.spread == -6.5
        assert odds.details == "KC -6.5"
        assert odds.favorite_abbreviation == "KC"
        assert odds.home_moneyline == -280

    def test_the_pregame_item_is_recognised_whether_playId_is_null_or_zero(self):
        """ESPN writes the pre-kickoff row both ways, and `in (None, 0)` is why.

        Narrowing it to `is None` left the suite green. The JavaScript port
        carries the same two-value check and is covered; this side was not, so
        the two parsers had asymmetric protection on one line of shared
        contract.
        """
        for play_id in (None, 0):
            prob = ESPNClient.parse_probability(
                {"items": [{"homeWinPercentage": 0.7, "awayWinPercentage": 0.3, "playId": play_id}]}
            )
            assert prob.is_pregame is True, f"playId {play_id!r} is the pregame row"

        mid_game = ESPNClient.parse_probability(
            {"items": [{"homeWinPercentage": 0.7, "awayWinPercentage": 0.3, "playId": 42}]}
        )
        assert mid_game.is_pregame is False, "a real play id is a live number, not a pregame one"

    def test_an_away_favourite_is_named_as_the_favourite(self):
        # `favorite` is read off whichever side carries it. With only the home
        # branch exercised, hard-coding the home team passed everything.
        away_fav = ESPNClient.parse_odds({"items": [{
            "details": "SF -3.5", "spread": 3.5,
            "homeTeamOdds": {"favorite": False, "team": {"abbreviation": "KC"}},
            "awayTeamOdds": {"favorite": True, "team": {"abbreviation": "SF"}},
        }]})
        assert away_fav.favorite_abbreviation == "SF"

        neither = ESPNClient.parse_odds({"items": [{
            "homeTeamOdds": {"favorite": False, "team": {"abbreviation": "KC"}},
            "awayTeamOdds": {"favorite": False, "team": {"abbreviation": "SF"}},
        }]})
        assert neither.favorite_abbreviation is None, "a pick-em names nobody"

    def test_parse_odds_handles_missing_data(self):
        assert ESPNClient.parse_odds(None) is None
        assert ESPNClient.parse_odds({"items": []}) is None
        empty = ESPNClient.parse_odds({"items": [{}]})
        assert empty.spread is None
        assert empty.favorite_abbreviation is None


class TestGetWeekGames:
    def test_enriches_games_with_probability_and_odds(self, tmp_path: Path):
        client = ESPNClient(cache_dir=tmp_path, cache_ttl_hours=1, min_request_interval=0)

        def fake_get(url, params=None, timeout=None):
            if "probabilities" in url:
                return _mock_response(SAMPLE_PROBABILITIES)
            if "odds" in url:
                return _mock_response(SAMPLE_ODDS)
            return _mock_response(SAMPLE_SCOREBOARD)

        client.session.get = MagicMock(side_effect=fake_get)
        games = client.get_week_games()

        real_game = next(g for g in games if g.event_id == "401547439")
        assert real_game.probability.home_win_pct == 0.78
        assert real_game.odds.spread == -6.5

    def test_probability_fetch_failure_does_not_break_batch(self, tmp_path: Path):
        client = ESPNClient(cache_dir=tmp_path, cache_ttl_hours=1, min_request_interval=0)

        def fake_get(url, params=None, timeout=None):
            if "probabilities" in url or "odds" in url:
                raise requests.ConnectionError("down")
            return _mock_response(SAMPLE_SCOREBOARD)

        client.session.get = MagicMock(side_effect=fake_get)
        games = client.get_week_games()

        assert len(games) == 2
        assert games[0].probability is None
        assert games[0].odds is None


class TestTheSelfImposedRateLimit:
    """The floor between outbound requests, which switched itself off on failure.

    `_last_request_at` was stamped only after a response came back, so a run
    that started failing stopped waiting between attempts -- the politeness
    limit disappeared at exactly the moment an unofficial, unsupported endpoint
    was least pleased to hear from us.
    """

    def test_a_failed_request_still_starts_the_clock(self, tmp_path: Path):
        client = ESPNClient(cache_dir=tmp_path, min_request_interval=0.05)
        with patch.object(client.session, "get", side_effect=requests.ConnectionError("nope")):
            assert client._fetch_json("https://example.invalid/a") is None
            stamped = client._last_request_at
        assert stamped > 0.0

    def test_consecutive_failures_are_spaced(self, tmp_path: Path):
        client = ESPNClient(cache_dir=tmp_path, min_request_interval=0.05)
        slept = []
        with patch.object(client.session, "get", side_effect=requests.ConnectionError("nope")), \
                patch("data.espn_client.time.sleep", side_effect=slept.append):
            for _ in range(3):
                client._fetch_json("https://example.invalid/a")
        # The first call has nothing to wait for; the two after it do.
        assert len([s for s in slept if s > 0]) == 2

    def test_a_non_json_body_also_starts_the_clock(self, tmp_path: Path):
        client = ESPNClient(cache_dir=tmp_path, min_request_interval=0.05)
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.side_effect = ValueError("not json")
        with patch.object(client.session, "get", return_value=resp):
            assert client._fetch_json("https://example.invalid/a") is None
            assert client._last_request_at > 0.0
