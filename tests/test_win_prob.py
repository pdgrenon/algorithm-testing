import pytest

from data.models import Game, Odds, Team, WinProbability
from models.win_prob import (
    DEFAULT_DEVIG_METHOD,
    DEVIG_METHODS,
    TIE_PROBABILITY,
    advance_probability,
    basis_phrase,
    devig,
    shrink_toward_prior,
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

    def test_the_two_sides_account_for_all_the_probability(self):
        # Not a mirror around 50 any more: the tie belongs to both sides here,
        # so the pair sums to 100 + P(tie) rather than to 100. What must still
        # hold is that nothing is lost or invented.
        home_pct = estimate_win_pct_from_spread(spread=-6.5, team_is_home=True)
        away_pct = estimate_win_pct_from_spread(spread=-6.5, team_is_home=False)
        assert home_pct + away_pct == pytest.approx(100.0 + TIE_PROBABILITY * 100, abs=1e-6)

    def test_it_is_a_mirror_again_once_a_tie_eliminates(self):
        home_pct = estimate_win_pct_from_spread(-6.5, True, tie_is_loss=True)
        away_pct = estimate_win_pct_from_spread(-6.5, False, tie_is_loss=True)
        assert home_pct + away_pct == pytest.approx(100.0 - TIE_PROBABILITY * 100, abs=1e-6)

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

    def test_the_two_sides_sum_to_more_than_one_hundred(self):
        """Because a tie advances *both* teams in this pool.

        This is the property that catches a tie fix applied in the wrong
        direction. P(home advances) and P(away advances) stopped being
        mutually exclusive the moment a tie stopped eliminating, so they must
        sum to 1 + P(tie), not to 1. A pair summing to exactly 100 would mean
        the tie mass had been silently redistributed to the two winners.
        """
        home = win_pct_from_moneylines(-280, 230, team_is_home=True)
        away = win_pct_from_moneylines(-280, 230, team_is_home=False)
        assert home + away == pytest.approx(100.0 + TIE_PROBABILITY * 100, abs=1e-6)
        assert home > away

    def test_with_a_tie_as_a_loss_they_sum_to_less_than_one_hundred(self):
        # The mirror image, and the case most survivor pools are in: the tie
        # mass belongs to neither side.
        home = win_pct_from_moneylines(-280, 230, True, DEFAULT_DEVIG_METHOD, True)
        away = win_pct_from_moneylines(-280, 230, False, DEFAULT_DEVIG_METHOD, True)
        assert home + away == pytest.approx(100.0 - TIE_PROBABILITY * 100, abs=1e-6)

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
        # Power de-vig, then the tie added back. Higher than the 70.9% the
        # multiplicative method gave: it was under-reading the favourite.
        assert resolved.win_pct == pytest.approx(72.2, abs=0.1)

    def test_spread_is_used_when_no_moneylines_are_posted(self):
        game = make_game(spread=-6.5)
        resolved = resolve_team_win_probability(game, team_is_home=True)
        assert resolved.source == "spread_estimate"

    def test_nothing_priced_is_unknown_rather_than_a_guess(self):
        resolved = resolve_team_win_probability(make_game(), team_is_home=True)
        assert resolved.source == "unknown"
        assert resolved.win_pct is None


class TestTheApiRungFoldsInTheTie:
    """The top of the source ladder, and the only rung whose tie handling was untested.

    ESPN publishes a three-way split, so unlike a two-way price the figure is
    already unconditional and the tie has to be *added* rather than divided
    out. `advance_probability` does the equivalent for the moneyline and spread
    rungs and is covered; this branch is separate code and was not, so
    inverting its `if not tie_is_loss` -- crediting the tie exactly when the
    pool counts it as a loss -- left the whole suite green on the path that is
    used whenever ESPN has a model at all.
    """

    def _game(self, tie_pct=0.02):
        game = make_game(home_win_pct=0.60, away_win_pct=0.38)
        game.probability.tie_pct = tie_pct
        return game

    def test_a_tie_that_advances_is_added_to_the_published_figure(self):
        resolved = resolve_team_win_probability(self._game(), team_is_home=True, tie_is_loss=False)
        assert resolved.source == "api"
        assert resolved.win_pct == pytest.approx(62.0), "60% to win plus 2% to tie, and a tie advances"

    def test_a_tie_that_eliminates_is_not(self):
        resolved = resolve_team_win_probability(self._game(), team_is_home=True, tie_is_loss=True)
        assert resolved.win_pct == pytest.approx(60.0)

    def test_the_difference_is_exactly_the_tie(self):
        advances = resolve_team_win_probability(self._game(0.031), team_is_home=True, tie_is_loss=False)
        eliminates = resolve_team_win_probability(self._game(0.031), team_is_home=True, tie_is_loss=True)
        assert advances.win_pct - eliminates.win_pct == pytest.approx(3.1)

    def test_both_sides_get_the_tie_because_both_advance_on_one(self):
        game = self._game(0.02)
        home = resolve_team_win_probability(game, team_is_home=True, tie_is_loss=False)
        away = resolve_team_win_probability(game, team_is_home=False, tie_is_loss=False)
        assert home.win_pct == pytest.approx(62.0)
        assert away.win_pct == pytest.approx(40.0), "38% to win plus the same 2%"

    def test_a_payload_with_no_tie_figure_is_unchanged_rather_than_refused(self):
        resolved = resolve_team_win_probability(self._game(None), team_is_home=True, tie_is_loss=False)
        assert resolved.win_pct == pytest.approx(60.0)
        assert resolved.source == "api"


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


class TestDevig:
    """Removing the book's margin. The method is a real choice, not a detail."""

    def test_every_method_returns_a_pair_summing_to_one(self):
        for method in DEVIG_METHODS:
            home, away = devig(0.7692, 0.3030, method)
            assert home + away == pytest.approx(1.0, abs=1e-9), method
            assert 0.0 <= away <= home <= 1.0, method

    def test_power_reads_the_favourite_higher_than_multiplicative(self):
        """The whole reason the default is `power`.

        The favourite-longshot bias means books shade longshot prices upward,
        so splitting the margin proportionally takes too much off the
        favourite. Survivor picks are nearly always the favourite, and the
        error compounds across a season of them.
        """
        mult, _ = devig(0.7692, 0.3030, "multiplicative")
        power, _ = devig(0.7692, 0.3030, "power")
        additive, _ = devig(0.7692, 0.3030, "additive")
        assert power > additive > mult

    def test_a_fair_pair_is_left_alone(self):
        # No overround, nothing to remove.
        for method in DEVIG_METHODS:
            home, away = devig(0.75, 0.25, method)
            assert home == pytest.approx(0.75, abs=1e-6), method

    def test_an_unknown_method_is_refused_rather_than_guessed(self):
        with pytest.raises(ValueError):
            devig(0.7, 0.35, "shin-ish")


class TestAdvanceProbability:
    def test_a_tie_is_worth_exactly_its_own_probability(self):
        assert advance_probability(0.80, tie_is_loss=False) - advance_probability(
            0.80, tie_is_loss=True
        ) == pytest.approx(TIE_PROBABILITY, abs=1e-12)

    def test_the_measured_tie_rate_is_nothing_like_the_published_formula(self):
        """0.215% measured, against ~3% from the normal approximation.

        Guards a specific regression: swapping the constant for the
        Phi((0.5-s)/sigma) formula that circulates in survivor writing would
        put a 3-point thumb on every game in the league. The formula measures
        "margin lands in (-0.5, 0.5)" on a continuous distribution and ignores
        that a tied game plays overtime.
        """
        assert 0.001 < TIE_PROBABILITY < 0.005


class TestShrinkage:
    def test_this_week_is_never_shrunk(self):
        # The current week is a posted line, not a projection.
        assert shrink_toward_prior(85.0, 0) == 85.0

    def test_nothing_is_shrunk_inside_the_measured_free_window(self):
        """Measured: a projection holds its accuracy about four weeks out.

        Shrinking inside that window throws away good information. The first
        draft of this function decayed from week one and would have marked an
        85% week-two projection down to 79.6%.
        """
        from models.win_prob import SHRINK_FREE_WEEKS

        for w in range(0, SHRINK_FREE_WEEKS + 1):
            assert shrink_toward_prior(85.0, w) == 85.0, f"week +{w} was shrunk"

    def test_confidence_decays_beyond_the_free_window(self):
        from models.win_prob import SHRINK_FREE_WEEKS

        far = list(range(SHRINK_FREE_WEEKS, 14))
        pcts = [shrink_toward_prior(85.0, w) for w in far]
        assert all(b < a for a, b in zip(pcts, pcts[1:])), "must be monotonic once it starts"
        assert pcts[-1] < 70.0, "a week-13 projection should be well hedged"

    def test_it_shrinks_toward_even_from_both_sides(self):
        assert shrink_toward_prior(85.0, 6) < 85.0
        assert shrink_toward_prior(15.0, 6) > 15.0

    def test_missing_stays_missing(self):
        assert shrink_toward_prior(None, 4) is None
