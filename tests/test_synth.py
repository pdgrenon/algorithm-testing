"""The synthetic season generator.

Its whole value is that it looks like the real thing, so the tests are the
calibration: if these drift, every policy comparison built on it is measuring
a league that does not exist. The tolerances are the residuals measured at the
time of fitting, not round numbers.
"""
import pytest

from models.win_prob import TIE_PROBABILITY, resolve_team_win_probability
from scripts.synth import (
    GAMES_PER_WEEK,
    STRENGTH_DRIFT_PHI,
    TEAM_STRENGTH_SD,
    WEEKS,
    describe,
    season,
)

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


class TestTeamsDrift:
    """The one fitted constant nothing was holding.

    The generator held a team as good in Week 18 as in Week 1 until drift was
    added, and that flatters any strategy hoarding a good team for later --
    which is most of what this harness compares. Setting STRENGTH_DRIFT_PHI
    back to 1.0 turns the drift off completely and passed every assertion in
    this file: the four calibrated quantities are per-week distributions and a
    stationary walk leaves all four alone.
    """

    def test_a_team_is_not_the_same_team_in_week_eighteen(self):
        # `season(seed, weeks=1)` never reaches the drift step, so its
        # strengths are the ones the season opened on.
        opening = season(11, weeks=1)[2]
        closing = season(11)[2]
        moved = [abs(closing[t] - opening[t]) for t in opening]
        assert max(moved) > 0.1, "no team moved at all across a season"
        assert sum(moved) / len(moved) > 0.2, "the league barely moved"

    def test_the_walk_is_mean_reverting_rather_than_free(self):
        """The failure the phi was chosen to avoid.

        A free walk widens the league every week, so by Week 18 the favourite
        is far stronger than any real board and every calibration above stops
        holding. Mean reversion keeps the stationary spread where it started.
        """
        import statistics

        opening, closing = [], []
        for seed in range(60):
            o = season(seed, weeks=1)[2]
            c = season(seed)[2]
            opening.extend(o.values())
            closing.extend(c.values())
        assert statistics.pstdev(opening) == pytest.approx(TEAM_STRENGTH_SD, abs=0.06)
        assert statistics.pstdev(closing) == pytest.approx(TEAM_STRENGTH_SD, abs=0.06)

    def test_the_measured_per_week_movement_is_what_phi_was_solved_for(self):
        """0.136 a week, which is the number the module's comment names.

        For an AR(1) held at a stationary spread of sigma, the step has
        variance 2*sigma^2*(1 - phi). The comment gives that formula and the
        figure it produces; this is that arithmetic, checked, so a phi edited
        without the comment goes red.
        """
        step_sd = (2 * TEAM_STRENGTH_SD**2 * (1 - STRENGTH_DRIFT_PHI)) ** 0.5
        assert step_sd == pytest.approx(0.136, abs=0.002)


class TestTheThreeWaySplit:
    """A tie is its own outcome and the two win probabilities share the rest.

    Dropping the `* (1 - tie_probability)` off the home side left the whole
    suite green: `p_away` is defined as the remainder, so the three still sum
    to one, and the distributional assertions absorb a 0.2% shift. What it
    breaks is the symmetry -- an evenly matched game stops being even, with
    every home side quietly a fraction of a point better than its price.
    """

    def _slate(self, seed=4):
        by_week, _outcomes, _strengths = season(seed, weeks=3)
        return [g for w in sorted(by_week) for g in by_week[w]]

    def test_the_three_outcomes_are_the_whole_of_the_probability(self):
        for game in self._slate():
            p = game.probability
            assert p.home_win_pct + p.away_win_pct + p.tie_pct == pytest.approx(1.0)

    def test_an_evenly_matched_game_is_even(self):
        # Straight at the generator, with the noise off and no home edge, so
        # the only thing left deciding the split is the tie arithmetic.
        by_week, _o, _s = season(
            0, weeks=1, teams=["AAA", "BBB"], strength_sd=0.0, home_edge=0.0, noise_sd=0.0,
        )
        [game] = by_week[1]
        p = game.probability
        assert p.home_win_pct == pytest.approx(p.away_win_pct), (
            "two identical teams at home advantage zero split what the tie leaves, evenly"
        )
        assert p.home_win_pct == pytest.approx((1.0 - p.tie_pct) / 2.0)

    def test_the_home_edge_is_the_only_thing_that_tilts_it(self):
        by_week, _o, _s = season(
            0, weeks=1, teams=["AAA", "BBB"], strength_sd=0.0, home_edge=0.4, noise_sd=0.0,
        )
        [game] = by_week[1]
        p = game.probability
        assert p.home_win_pct > p.away_win_pct
        assert p.home_win_pct + p.away_win_pct == pytest.approx(1.0 - p.tie_pct)

    def test_no_side_is_ever_priced_negative(self):
        for game in self._slate(seed=9):
            assert game.probability.home_win_pct > 0
            assert game.probability.away_win_pct > 0
