import pytest

from data.models import Game, Odds, Team, WinProbability
from models.win_prob import (
    basis_phrase,
    build_win_probability_table,
    estimate_win_pct_from_spread,
    get_team_win_pct,
    implied_prob_from_moneyline,
    resolve_team_win_probability,
    win_pct_from_moneylines,
)


def make_game(
    week=3,
    home_abbr="KC",
    away_abbr="DEN",
    home_win_pct=None,
    away_win_pct=None,
    spread=None,
    home_moneyline=None,
    away_moneyline=None,
):
    probability = None
    if home_win_pct is not None or away_win_pct is not None:
        probability = WinProbability(home_win_pct=home_win_pct, away_win_pct=away_win_pct)
    odds = None
    if spread is not None or home_moneyline is not None or away_moneyline is not None:
        odds = Odds(
            spread=spread, home_moneyline=home_moneyline, away_moneyline=away_moneyline
        )
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


class TestMoneylines:
    """The de-vigged market price, which outranks the spread estimate."""

    def test_favourite_and_underdog_convert(self):
        # -200 risks 200 to win 100: 200/300.
        assert implied_prob_from_moneyline(-200) == pytest.approx(2 / 3)
        # +150 wins 150 on 100: 100/250.
        assert implied_prob_from_moneyline(150) == pytest.approx(0.4)

    def test_zero_and_missing_are_absent_not_priced(self):
        # A zero is not a price. Dividing by it would raise; reading it as
        # even money would invent a number nobody published.
        assert implied_prob_from_moneyline(0) is None
        assert implied_prob_from_moneyline(None) is None

    def test_devigged_pair_sums_to_one_hundred(self):
        home = win_pct_from_moneylines(-280, 230, team_is_home=True)
        away = win_pct_from_moneylines(-280, 230, team_is_home=False)
        assert home + away == pytest.approx(100.0)
        assert home > away

    def test_devig_removes_the_overround(self):
        # Raw implied probabilities sum to about 104%; that excess is the
        # book's margin and must not read as confidence. Both raw shares are
        # above their de-vigged values.
        raw_home = implied_prob_from_moneyline(-280) * 100
        assert raw_home > win_pct_from_moneylines(-280, 230, team_is_home=True)

    def test_one_price_alone_is_not_enough(self):
        # A single side carries the margin with no way to separate it out.
        assert win_pct_from_moneylines(-280, None, team_is_home=True) is None
        assert win_pct_from_moneylines(None, 230, team_is_home=False) is None


class TestSourcePreference:
    """api > moneyline > spread_estimate > unknown, and nothing skips a rung."""

    def test_api_beats_moneylines(self):
        game = make_game(home_win_pct=0.78, away_win_pct=0.22, home_moneyline=-280, away_moneyline=230)
        resolved = resolve_team_win_probability(game, team_is_home=True)
        assert resolved.source == "api"
        assert resolved.win_pct == pytest.approx(78.0)

    def test_moneylines_beat_the_spread_estimate(self):
        # Both are present; the market price is the better number and wins.
        game = make_game(spread=-6.5, home_moneyline=-280, away_moneyline=230)
        resolved = resolve_team_win_probability(game, team_is_home=True)
        assert resolved.source == "moneyline"
        assert resolved.win_pct == pytest.approx(70.9, abs=0.1)

    def test_spread_is_used_when_no_moneylines_are_posted(self):
        game = make_game(spread=-6.5)
        resolved = resolve_team_win_probability(game, team_is_home=True)
        assert resolved.source == "spread_estimate"

    def test_nothing_priced_is_unknown_rather_than_a_guess(self):
        resolved = resolve_team_win_probability(make_game(), team_is_home=True)
        assert resolved.source == "unknown"
        assert resolved.win_pct is None


class TestSpreadCalibration:
    """The logistic replaced a linear 1.2-points-per-point rule that was badly off.

    These anchors are the observed rates in the sample the curve was fitted to
    (nflverse, 2015-2025). They are loose on purpose -- the point is that a
    14-point favourite is in the high eighties rather than the mid sixties, not
    that the curve hits any particular decimal.
    """

    def test_three_point_favourite(self):
        assert estimate_win_pct_from_spread(-3, team_is_home=True) == pytest.approx(60, abs=3)

    def test_seven_point_favourite(self):
        assert estimate_win_pct_from_spread(-7, team_is_home=True) == pytest.approx(72, abs=3)

    def test_fourteen_point_favourite_is_not_a_coin_flip(self):
        # The old rule said 66.4% here. Such teams win about 93% of the time.
        assert estimate_win_pct_from_spread(-14, team_is_home=True) > 85

    def test_pick_em_is_close_to_even(self):
        assert estimate_win_pct_from_spread(0, team_is_home=True) == pytest.approx(50, abs=2)

    def test_curve_is_monotonic_in_the_spread(self):
        pcts = [estimate_win_pct_from_spread(-s, team_is_home=True) for s in range(0, 21)]
        assert all(b >= a for a, b in zip(pcts, pcts[1:]))


class TestBasisPhrase:
    """One definition, because several surfaces draw it and parity compares it."""

    def test_each_source_is_named_or_deliberately_silent(self):
        assert basis_phrase("spread_estimate") == " (estimated from spread)"
        assert basis_phrase("moneyline") == " (de-vigged moneyline)"
        # Silence has always meant "ESPN's published figure" on these surfaces.
        assert basis_phrase("api") == ""
        assert basis_phrase("unknown") == ""
