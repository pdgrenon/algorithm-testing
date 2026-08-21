from data.models import Game, Odds, Team, WinProbability
from models.win_prob import (
    build_win_probability_table,
    estimate_win_pct_from_spread,
    get_team_win_pct,
    resolve_team_win_probability,
)


def make_game(
    week=3,
    home_abbr="KC",
    away_abbr="DEN",
    home_win_pct=None,
    away_win_pct=None,
    spread=None,
):
    probability = None
    if home_win_pct is not None or away_win_pct is not None:
        probability = WinProbability(home_win_pct=home_win_pct, away_win_pct=away_win_pct)
    odds = Odds(spread=spread) if spread is not None else None
    return Game(
        event_id="1",
        competition_id="1",
        week=week,
        season_year=2026,
        home=Team(abbreviation=home_abbr, display_name="Kansas City Chiefs"),
        away=Team(abbreviation=away_abbr, display_name="Denver Broncos"),
        probability=probability,
        odds=odds,
    )


class TestEstimateFromSpread:
    def test_home_favorite_above_50(self):
        # spread negative = home favored
        pct = estimate_win_pct_from_spread(spread=-6.5, team_is_home=True)
        assert pct > 50.0

    def test_home_underdog_below_50(self):
        pct = estimate_win_pct_from_spread(spread=6.5, team_is_home=True)
        assert pct < 50.0

    def test_away_side_is_mirror_of_home(self):
        home_pct = estimate_win_pct_from_spread(spread=-6.5, team_is_home=True)
        away_pct = estimate_win_pct_from_spread(spread=-6.5, team_is_home=False)
        assert abs((home_pct - 50.0) - (50.0 - away_pct)) < 1e-9

    def test_missing_spread_returns_none(self):
        assert estimate_win_pct_from_spread(spread=None, team_is_home=True) is None

    def test_clamped_to_range(self):
        assert estimate_win_pct_from_spread(spread=-100, team_is_home=True) <= 99.0
        assert estimate_win_pct_from_spread(spread=100, team_is_home=True) >= 1.0


class TestResolveTeamWinProbability:
    def test_prefers_api_field_and_converts_to_percent_scale(self):
        game = make_game(home_win_pct=0.78, away_win_pct=0.22, spread=-6.5)
        home = resolve_team_win_probability(game, team_is_home=True)
        assert home.source == "api"
        assert home.win_pct == 78.0
        assert home.team_abbreviation == "KC"
        assert home.opponent_abbreviation == "DEN"

    def test_falls_back_to_spread_when_api_missing(self):
        game = make_game(spread=-6.5)
        home = resolve_team_win_probability(game, team_is_home=True)
        assert home.source == "spread_estimate"
        assert home.win_pct is not None
        assert home.win_pct > 50.0

    def test_unknown_when_nothing_available(self):
        game = make_game()
        home = resolve_team_win_probability(game, team_is_home=True)
        assert home.source == "unknown"
        assert home.win_pct is None


class TestBuildWinProbabilityTable:
    def test_builds_entries_for_both_teams(self):
        games = [make_game(week=1, home_win_pct=0.6, away_win_pct=0.4)]
        table = build_win_probability_table(games)
        assert table[("KC", 1)].win_pct == 60.0
        assert table[("DEN", 1)].win_pct == 40.0

    def test_spans_multiple_weeks(self):
        games = [
            make_game(week=1, home_abbr="KC", away_abbr="DEN", home_win_pct=0.6, away_win_pct=0.4),
            make_game(week=2, home_abbr="KC", away_abbr="LV", home_win_pct=0.7, away_win_pct=0.3),
        ]
        table = build_win_probability_table(games)
        assert get_team_win_pct(table, "KC", 1) == 60.0
        assert get_team_win_pct(table, "KC", 2) == 70.0

    def test_bye_week_produces_no_entry(self):
        games = [make_game(week=1, home_win_pct=0.6, away_win_pct=0.4)]
        table = build_win_probability_table(games)
        assert get_team_win_pct(table, "KC", 2) is None

    def test_skips_games_missing_week_or_abbreviation(self):
        no_week = make_game(week=None, home_win_pct=0.6, away_win_pct=0.4)
        no_abbr = make_game(week=1, home_abbr=None, home_win_pct=0.6, away_win_pct=0.4)
        table = build_win_probability_table([no_week, no_abbr])
        assert table == {("DEN", 1): table[("DEN", 1)]}
