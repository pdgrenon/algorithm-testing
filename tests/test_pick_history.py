from unittest.mock import patch

from data.models import Game, Team
from pick_history import (
    build_combined_pick_history,
    build_pick_history,
    format_result_text,
)


def make_finished_game(event_id, week, home, away, home_score, away_score):
    home_winner = home_score > away_score
    away_winner = away_score > home_score
    return Game(
        event_id=event_id,
        competition_id=event_id,
        week=week,
        season_year=2026,
        state="post",
        home=Team(abbreviation=home, display_name=home, score=home_score, winner=home_winner),
        away=Team(abbreviation=away, display_name=away, score=away_score, winner=away_winner),
    )


def make_pending_game(event_id, week, home, away):
    return Game(
        event_id=event_id,
        competition_id=event_id,
        week=week,
        season_year=2026,
        state="pre",
        home=Team(abbreviation=home, display_name=home),
        away=Team(abbreviation=away, display_name=away),
    )


class FakeESPNClient:
    def __init__(self, games_by_week):
        self.games_by_week = games_by_week

    def get_week_games(self, week=None, seasontype=None, include_probability=True, include_odds=True):
        return self.games_by_week.get(week, [])


class TestBuildPickHistory:
    def test_win_resolved_correctly(self, tmp_path):
        client = FakeESPNClient({1: [make_finished_game("1", 1, "KC", "DEN", 27, 20)]})
        with patch("pick_history.load_picks_for_entry", return_value=[{"week": 1, "team": "KC"}]):
            results = build_pick_history(client, "Entry A")
        assert results[0].result == "win"
        assert results[0].team_score == 27
        assert results[0].opponent_score == 20
        assert results[0].opponent == "DEN"

    def test_loss_resolved_correctly(self):
        client = FakeESPNClient({1: [make_finished_game("1", 1, "KC", "DEN", 20, 27)]})
        with patch("pick_history.load_picks_for_entry", return_value=[{"week": 1, "team": "KC"}]):
            results = build_pick_history(client, "Entry A")
        assert results[0].result == "loss"

    def test_tie_resolved_correctly(self):
        client = FakeESPNClient({1: [make_finished_game("1", 1, "KC", "DEN", 20, 20)]})
        with patch("pick_history.load_picks_for_entry", return_value=[{"week": 1, "team": "KC"}]):
            results = build_pick_history(client, "Entry A")
        assert results[0].result == "tie"

    def test_pending_game_not_yet_final(self):
        client = FakeESPNClient({1: [make_pending_game("1", 1, "KC", "DEN")]})
        with patch("pick_history.load_picks_for_entry", return_value=[{"week": 1, "team": "KC"}]):
            results = build_pick_history(client, "Entry A")
        assert results[0].result == "pending"
        assert results[0].team_score is None

    def test_team_not_found_in_week_is_unknown(self):
        client = FakeESPNClient({1: [make_finished_game("1", 1, "SF", "DAL", 24, 10)]})
        with patch("pick_history.load_picks_for_entry", return_value=[{"week": 1, "team": "KC"}]):
            results = build_pick_history(client, "Entry A")
        assert results[0].result == "unknown"

    def test_pick_with_no_week_is_unknown_without_fetching(self):
        client = FakeESPNClient({})
        with patch("pick_history.load_picks_for_entry", return_value=[{"week": None, "team": "KC"}]):
            results = build_pick_history(client, "Entry A")
        assert results[0].result == "unknown"
        assert results[0].week is None


class TestBuildCombinedPickHistory:
    def test_merges_both_entries_by_week(self):
        client = FakeESPNClient(
            {
                1: [
                    make_finished_game("1", 1, "KC", "DEN", 27, 20),
                    make_finished_game("2", 1, "SF", "DAL", 10, 24),
                ]
            }
        )

        def fake_picks(entry):
            if entry == "Entry A":
                return [{"week": 1, "team": "KC"}]
            return [{"week": 1, "team": "DAL"}]

        with patch("pick_history.load_picks_for_entry", side_effect=fake_picks):
            rows = build_combined_pick_history(client)

        assert len(rows) == 1
        assert rows[0].week == 1
        assert rows[0].entry_a.result == "win"
        assert rows[0].entry_b.result == "win"

    def test_week_with_only_one_entry_picking(self):
        client = FakeESPNClient({1: [make_finished_game("1", 1, "KC", "DEN", 27, 20)]})

        def fake_picks(entry):
            return [{"week": 1, "team": "KC"}] if entry == "Entry A" else []

        with patch("pick_history.load_picks_for_entry", side_effect=fake_picks):
            rows = build_combined_pick_history(client)

        assert rows[0].entry_a is not None
        assert rows[0].entry_b is None

    def test_no_picks_returns_empty(self):
        client = FakeESPNClient({})
        with patch("pick_history.load_picks_for_entry", return_value=[]):
            assert build_combined_pick_history(client) == []


class TestFormatResultText:
    def test_win_includes_score_and_opponent(self):
        client = FakeESPNClient({1: [make_finished_game("1", 1, "KC", "DEN", 27, 20)]})
        with patch("pick_history.load_picks_for_entry", return_value=[{"week": 1, "team": "KC"}]):
            results = build_pick_history(client, "Entry A")
        assert format_result_text(results[0]) == "KC W 27-20 vs DEN"

    def test_none_pick_renders_as_dash(self):
        assert format_result_text(None) == "-"


def make_live_game(event_id, week, home, away, home_score, away_score):
    """Kicked off, not finished. ESPN publishes a score and no winner yet."""
    return Game(
        event_id=event_id,
        competition_id=event_id,
        week=week,
        season_year=2026,
        state="in",
        home=Team(abbreviation=home, display_name=home, score=home_score, winner=None),
        away=Team(abbreviation=away, display_name=away, score=away_score, winner=None),
    )


class TestAGameStillBeingPlayed:
    """Pending, not unknown, and the distinction is the whole point of the row.

    `game.state != "post"` is what carries that. Narrowing it to
    `game.state == "pre"` left the suite green while a game in progress fell
    through to the scoring branch, found no winner, and reported "?" -- which
    reads as "something is wrong with this pick" rather than "the game is on".
    """

    def test_a_game_in_progress_is_pending(self):
        client = FakeESPNClient({3: [make_live_game("1", 3, "KC", "DEN", 14, 10)]})
        with patch("pick_history.load_picks_for_entry", return_value=[{"week": 3, "team": "KC"}]):
            [result] = build_pick_history(client, "Entry A")
        assert result.result == "pending"
        assert result.opponent == "DEN"

    def test_and_reads_as_pending_rather_than_a_question_mark(self):
        client = FakeESPNClient({3: [make_live_game("1", 3, "KC", "DEN", 14, 10)]})
        with patch("pick_history.load_picks_for_entry", return_value=[{"week": 3, "team": "KC"}]):
            [result] = build_pick_history(client, "Entry A")
        assert format_result_text(result) == "KC Pending vs DEN"

    def test_a_game_not_started_is_pending_too(self):
        client = FakeESPNClient({3: [make_pending_game("1", 3, "KC", "DEN")]})
        with patch("pick_history.load_picks_for_entry", return_value=[{"week": 3, "team": "KC"}]):
            [result] = build_pick_history(client, "Entry A")
        assert result.result == "pending"
