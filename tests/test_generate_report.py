import sys
from unittest.mock import patch

from data.models import Game, Odds, Team, WinProbability


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
    def __init__(self, *args, **kwargs):
        pass

    def get_week_games(self, week=None, seasontype=None):
        return [make_game()] if week in (None, 5) else []


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
