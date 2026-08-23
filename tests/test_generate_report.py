import inspect
import sys
from unittest.mock import patch

from data.espn_client import ESPNClient
from data.models import Game, Odds, Team, WinProbability
from state.entries_store import record_pick


def make_game(event_id="1", week=5, home_win_pct=0.7, away_win_pct=0.3, spread=-4.0, details="KC -4"):
    return Game(
        event_id=event_id,
        competition_id=event_id,
        week=week,
        season_year=2026,
        state="pre",
        home=Team(abbreviation="KC", display_name="KC"),
        away=Team(abbreviation="DEN", display_name="DEN"),
        probability=WinProbability(home_win_pct=home_win_pct, away_win_pct=away_win_pct),
        odds=Odds(spread=spread, details=details),
    )


class FakeESPNClient:
    """The real client's shape, without the network.

    The signature is copied rather than shortened, and there is a test below
    holding it there. It used to take `(week, seasontype)` only, which was
    enough for the report pipeline and not for `pick_history`, which passes
    `include_probability` and `include_odds` too -- so the moment an entry had
    a recorded pick this stub raised TypeError from inside a test about
    generating HTML.
    """

    def __init__(self, *args, **kwargs):
        pass

    def get_week_games(self, week=None, year=None, seasontype=None,
                       include_probability=True, include_odds=True):
        return [make_game()] if week in (None, 5) else []


def test_the_stub_can_be_called_the_way_the_real_client_is():
    # A stand-in is only honest while it accepts what the real one accepts,
    # and a signature is exactly the kind of thing that moves under one
    # without the other noticing. Same guard as `_same_shape` in
    # scripts/backtest.py, for the same reason.
    assert (list(inspect.signature(FakeESPNClient.get_week_games).parameters)
            == list(inspect.signature(ESPNClient.get_week_games).parameters))


class TestGenerateReport:
    def test_writes_html_file(self, tmp_path, monkeypatch):
        out_path = tmp_path / "docs" / "index.html"
        monkeypatch.setattr(sys, "argv", ["generate_report.py", "--out", str(out_path)])

        with patch("generate_report.ESPNClient", FakeESPNClient):
            import generate_report

            generate_report.main()

        assert out_path.exists()
        content = out_path.read_text()
        assert "<!doctype html>" in content.lower()
        assert "KC" in content

    def test_writes_fallback_page_when_no_data(self, tmp_path, monkeypatch):
        out_path = tmp_path / "docs" / "index.html"
        monkeypatch.setattr(sys, "argv", ["generate_report.py", "--out", str(out_path)])

        class EmptyClient:
            def __init__(self, *a, **k):
                pass

            def get_week_games(self, week=None, seasontype=None):
                return []

        with patch("generate_report.ESPNClient", EmptyClient):
            import generate_report

            generate_report.main()

        content = out_path.read_text()
        assert "No game data was available" in content

    def test_a_recorded_pick_reaches_the_history_table(self, tmp_path, monkeypatch):
        """The path that was never exercised end to end.

        `build_weekly_report` resolves every recorded pick against the week it
        was made in, and with an empty pick log that whole branch is skipped --
        which is what the committed state files are, so nothing here ever ran
        it. conftest gives each test its own state directory, so a pick can be
        recorded without touching the repository's own.
        """
        record_pick("Entry A", "KC", 5)
        out_path = tmp_path / "report.html"
        monkeypatch.setattr(sys, "argv", ["generate_report.py", "--out", str(out_path)])

        with patch("generate_report.ESPNClient", FakeESPNClient):
            import generate_report

            generate_report.main()

        content = out_path.read_text()
        assert "Pick history" in content
        assert "No picks recorded yet" not in content
        # The fixture game is still "pre", so the pick has not settled.
        assert "Pending" in content
