"""The synthetic season generator.

Its whole value is that it looks like the real thing, so the tests are the
calibration: if these drift, every policy comparison built on it is measuring
a league that does not exist. The tolerances are the residuals measured at the
time of fitting, not round numbers.
"""
import pytest

from models.win_prob import TIE_PROBABILITY, resolve_team_win_probability
from scripts.synth import GAMES_PER_WEEK, WEEKS, describe, season

# Measured over 174 real week-slates, 2015-2024.
REAL = {
    "favourite_mean": 0.668, "favourite_sd": 0.103,
    "best_mean": 0.852, "best_sd": 0.054,
    "chalk_win_rate": 0.833, "games_per_week": 15.07,
}


@pytest.fixture(scope="module")
def measured():
    """120 seasons, which is about 2,000 week-slates against the real 174.

    Module-scoped because it is the one slow thing here and every assertion
    below reads the same numbers.
    """
    return describe(seasons=120)


class TestItLooksLikeTheRealThing:
    """Slow-ish by this suite's standards, and the reason the module exists."""

    def test_the_favourite_is_priced_about_right(self, measured):
        # Runs about a point and a half soft: the residual of fitting a normal
        # rating spread to a league with a fatter tail of genuinely bad teams.
        assert measured["favourite_mean"] == pytest.approx(REAL["favourite_mean"], abs=0.03)
        assert measured["favourite_sd"] == pytest.approx(REAL["favourite_sd"], abs=0.02)

    def test_the_best_team_on_the_board_is_about_as_good(self, measured):
        """The number that matters most, because every strategy starts here.

        If the chalk were 0.90 rather than 0.85 the whole field would survive
        longer and the pool would not empty, which changes every conclusion
        about depth.
        """
        assert measured["best_mean"] == pytest.approx(REAL["best_mean"], abs=0.03)
        assert measured["best_sd"] == pytest.approx(REAL["best_sd"], abs=0.02)

    def test_the_chalk_wins_about_as_often_as_it_really_does(self, measured):
        # 0.833 measured over 174 weeks has a standard error of 0.028, so the
        # bar here is that band rather than the point estimate.
        assert measured["chalk_win_rate"] == pytest.approx(REAL["chalk_win_rate"], abs=0.04)

    def test_there_are_about_as_many_games(self, measured):
        assert measured["games_per_week"] == pytest.approx(REAL["games_per_week"], abs=0.3)


class TestTheSeasonIsWellFormed:
    def test_a_seed_gives_the_same_season_every_time(self):
        """Common random numbers rest on this entirely.

        Two strategies compared on seed 7 have to face the same schedule, the
        same strengths and the same results, or the difference between them is
        partly the weather.
        """
        first = season(7)
        second = season(7)
        assert first[1] == second[1], "the outcomes must be identical"
        assert first[2] == second[2], "and so must the strengths"
        assert [g.home.abbreviation for g in first[0][1]] == [
            g.home.abbreviation for g in second[0][1]
        ]

    def test_different_seeds_give_different_seasons(self):
        assert season(1)[1] != season(2)[1]

    def test_no_team_plays_twice_in_one_week(self):
        by_week, _, _ = season(3)
        for week, slate in by_week.items():
            playing = [t for g in slate for t in (g.home.abbreviation, g.away.abbreviation)]
            assert len(playing) == len(set(playing)), f"week {week} double-books a team"

    def test_every_week_has_a_plausible_number_of_games(self):
        allowed = {count for count, _ in GAMES_PER_WEEK}
        by_week, _, _ = season(4)
        assert len(by_week) == WEEKS
        for week, slate in by_week.items():
            assert len(slate) in allowed, (week, len(slate))

    def test_every_game_records_an_outcome_for_both_sides(self):
        by_week, outcomes, _ = season(5)
        for week, slate in by_week.items():
            for game in slate:
                assert (week, game.home.abbreviation) in outcomes
                assert (week, game.away.abbreviation) in outcomes

    def test_exactly_one_side_wins_unless_it_is_a_tie(self):
        by_week, outcomes, _ = season(6)
        for week, slate in by_week.items():
            for game in slate:
                results = {
                    outcomes[(week, game.home.abbreviation)],
                    outcomes[(week, game.away.abbreviation)],
                }
                # {"win","loss"} normally; {"win"} when it was a tie, because a
                # tie is a win for both sides in this pool.
                assert results in ({"win", "loss"}, {"win"}), results


class TestTheEngineCanReadIt:
    """The point of returning the real dataclasses rather than a new shape."""

    def test_the_price_resolves_off_the_top_rung(self):
        by_week, _, _ = season(8)
        game = by_week[1][0]
        home = resolve_team_win_probability(game, True)
        assert home.source == "api", "the synthetic world is one where the book is right"
        assert 1.0 < home.win_pct < 99.0

    def test_the_two_sides_sum_to_more_than_a_hundred_by_the_tie(self):
        """Because a tie is not a loss, so both sides advance on one.

        Written as percentages first, which the resolver multiplies by 100 --
        so every side clamped to 99% and every game had two teams certain to
        advance. Nothing about a board where no pick can be wrong looks wrong
        in a strategy's output, which is why this assertion is here.
        """
        by_week, _, _ = season(9)
        for game in by_week[1]:
            home = resolve_team_win_probability(game, True).win_pct
            away = resolve_team_win_probability(game, False).win_pct
            assert home + away == pytest.approx(100.0 + TIE_PROBABILITY * 100.0, abs=0.01)
            assert home < 99.0 and away < 99.0

    def test_a_full_season_of_prices_is_never_degenerate(self):
        by_week, _, _ = season(10)
        for week, slate in by_week.items():
            for game in slate:
                p = resolve_team_win_probability(game, True).win_pct
                assert 1.0 < p < 99.0, (week, p)
