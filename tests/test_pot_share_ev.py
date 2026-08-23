"""Expected pot share for one week.

The load-bearing test here is the first one: the fast convolution must agree
with brute-force enumeration over every outcome. If those two ever part company
the convolution is quietly mis-scoring every pick, and nothing about the output
would look wrong.
"""
import random

import pytest

from models.pot_share_ev import (
    WeekGame,
    apportion,
    enumerate_pot_share,
    expected_pot_share,
    rank_by_pot_share,
)


def random_board(rng, n):
    """A board whose popularity sums to 1, which is what a real one does.

    The first version of this drew each side's share from uniform(0, 0.35),
    so a nine-game board described a field three times larger than the pool.
    Every clamp in the model fired on every evaluation, and the test was
    measuring the clamp rather than the convolution.
    """
    weights = [rng.expovariate(1.0) for _ in range(2 * n)]
    total = sum(weights)
    shares = [w / total for w in weights]
    return [
        WeekGame(f"H{i}", f"A{i}", rng.uniform(0.5, 0.95), shares[2 * i], shares[2 * i + 1])
        for i in range(n)
    ]


def board(rows):
    """rows: [(home, away, p_home, share_home, share_away)]"""
    return [WeekGame(h, a, p, sh, sa) for h, a, p, sh, sa in rows]


SIMPLE = board([
    ("KC", "DEN", 0.85, 0.55, 0.01),
    ("BUF", "NYJ", 0.78, 0.20, 0.02),
    ("SF", "ARI", 0.72, 0.15, 0.02),
    ("PHI", "NYG", 0.65, 0.04, 0.01),
])


class TestTheConvolutionIsExact:
    """The whole reason there are two implementations."""

    @pytest.mark.parametrize("team", ["KC", "BUF", "SF", "PHI", "DEN", "NYJ"])
    def test_it_matches_brute_force_enumeration(self, team):
        fast = expected_pot_share(SIMPLE, team, opponents_alive=200).ev
        slow = enumerate_pot_share(SIMPLE, team, opponents_alive=200)
        assert fast == pytest.approx(slow, rel=1e-6), (
            f"convolution and enumeration disagree on {team}: {fast} vs {slow}"
        )

    def test_it_matches_on_randomly_generated_boards(self):
        # Not a fixed board: a shape the author did not choose is the one that
        # catches an off-by-one. Exact, not approximate -- both sides apportion
        # the field to whole entries, so there is no quantisation between them
        # and any disagreement at all is a bug.
        rng = random.Random(17)
        for _ in range(12):
            games = random_board(rng, rng.randint(3, 9))
            n = len(games)
            for team in (f"H{rng.randrange(n)}", f"A{rng.randrange(n)}"):
                fast = expected_pot_share(games, team, opponents_alive=150).ev
                slow = enumerate_pot_share(games, team, opponents_alive=150)
                assert fast == pytest.approx(slow, rel=1e-12), team

    def test_it_matches_at_the_pool_sizes_that_actually_occur(self):
        """Agreement must not depend on the field being large.

        Late in a season the field is tiny and the apportionment is coarse --
        four opponents across sixteen games means most teams hold nobody. That
        is where a rounding scheme that does not preserve the total shows up.
        """
        rng = random.Random(4)
        games = random_board(rng, 6)
        for n in (250, 200, 50, 11, 4, 1):
            for team in ("H0", "A3", "H5"):
                fast = expected_pot_share(games, team, opponents_alive=n).ev
                slow = enumerate_pot_share(games, team, opponents_alive=n)
                assert fast == pytest.approx(slow, rel=1e-12), f"{team} at N={n}"


class TestTheFieldAddsUp:
    """An entry is not divisible, and the parts have to sum to the whole."""

    def test_apportioning_preserves_the_total(self):
        rng = random.Random(99)
        for _ in range(200):
            n = rng.randint(2, 32)
            weights = [rng.expovariate(1.0) for _ in range(n)]
            shares = [w / sum(weights) for w in weights]
            for total in (250, 137, 17, 3, 1):
                seats = apportion(shares, total)
                assert sum(seats) == total, (shares, total, seats)
                assert all(s >= 0 for s in seats)

    def test_it_does_not_depend_on_the_order_ties_arrive_in(self):
        # Four identical shares into 250 seats: 62.5 each, so two get 63 and
        # two get 62. Which two must be decided by position, not by chance.
        assert apportion([0.25] * 4, 250) == [63, 63, 62, 62]
        assert apportion([0.25] * 4, 250) == apportion([0.25] * 4, 250)

    def test_a_partial_board_keeps_its_own_total(self):
        # Two games out of sixteen: the other opponents are elsewhere, and
        # apportionment must not inflate these two to cover the whole field.
        assert sum(apportion([0.30, 0.02, 0.10, 0.01], 250)) == round(0.43 * 250)

    def test_a_board_holding_more_than_the_field_is_refused(self):
        # Popularity summing over 1 is a caller error, and clamping it would
        # answer confidently with a field that cannot exist.
        with pytest.raises(ValueError):
            expected_pot_share(
                board([("AAA", "XXX", 0.7, 0.8, 0.1), ("BBB", "YYY", 0.7, 0.8, 0.1)]),
                "AAA",
                opponents_alive=200,
            )


class TestTheMechanism:
    def test_a_less_popular_team_is_worth_more_at_equal_win_probability(self):
        """The entire point, isolated.

        Two identical prices, one crowded and one not. Being right while others
        are wrong is what pays, so the empty one must score higher.
        """
        games = board([
            ("AAA", "XXX", 0.75, 0.60, 0.01),
            ("BBB", "YYY", 0.75, 0.05, 0.01),
        ])
        crowded = expected_pot_share(games, "AAA", opponents_alive=200).ev
        empty = expected_pot_share(games, "BBB", opponents_alive=200).ev
        assert empty > crowded

    def test_a_big_enough_price_gap_still_beats_being_contrarian(self):
        """There is no rule here, only the multiplication.

        The same crowded/empty pair, but the crowded team is now far more
        likely to win. Popularity does not automatically win the argument, and
        a strategy that always fades the field has misunderstood it.
        """
        games = board([
            ("AAA", "XXX", 0.93, 0.60, 0.01),
            ("BBB", "YYY", 0.55, 0.05, 0.01),
        ])
        assert (
            expected_pot_share(games, "AAA", opponents_alive=200).ev
            > expected_pot_share(games, "BBB", opponents_alive=200).ev
        )

    def test_a_neutral_pick_scores_exactly_one(self):
        # Normalised by (N + E), so a pick that neither helps nor hurts sits at
        # 1.00 and the number reads as a multiple of fair. Nobody is eliminated
        # here -- every side holding anybody is certain to win -- so the pot is
        # split the same way it would have been had you not played.
        games = board([("AAA", "XXX", 1.0, 0.5, 0.0), ("BBB", "YYY", 1.0, 0.5, 0.0)])
        ev = expected_pot_share(games, "AAA", opponents_alive=100).ev
        assert ev == pytest.approx(1.0, rel=1e-12)

    def test_losing_teams_are_priced_too_rather_than_refused(self):
        # An underdog is a legal pick and has to be scoreable, however bad.
        ev = expected_pot_share(SIMPLE, "DEN", opponents_alive=200)
        assert ev.win_prob == pytest.approx(0.15)
        assert ev.ev > 0


class TestYourOwnEntriesCount:
    def test_holding_two_entries_lowers_your_own_share(self):
        """You are in your own denominator, twice.

        Two entries surviving together split the same pot between them, so each
        one is worth less than a single entry surviving alone. That convexity
        is the whole reason the two-entry problem is not separable.
        """
        one = expected_pot_share(SIMPLE, "KC", opponents_alive=50, own_entries_alive=1).ev
        two = expected_pot_share(SIMPLE, "KC", opponents_alive=50, own_entries_alive=2).ev
        assert two < one

    def test_a_thinner_field_lowers_the_multiple_because_you_are_in_it(self):
        """Written the other way round first, and the measurement said no.

        The intuition was that a survivor is worth more when few survive, so
        the multiple should climb as the field thins. It does the opposite --
        measured on this board, 1.0097 against 400 opponents and 1.0064
        against 50 -- and the reason is the normalisation. The number is a
        multiple of *fair*, and fair is 1/(N+E). Your own entry is one of those
        N+E, and it survives with certainty in this conditional world while
        every opponent only survives with probability. Against 400 opponents
        your entry is a rounding error in the denominator; against 50 it is a
        fiftieth of it, so the pot you are dividing has already been shrunk by
        your own guaranteed presence before any opponent is eliminated.

        The intuition was not simply backwards, it was measuring the wrong
        quantity. What rises in a thin field is your raw *fraction* of the pot
        -- against fifty opponents you expect a fifty-first of it and against
        four hundred a four-hundred-and-first. The multiple falls anyway
        because the pot it is a fraction of has shrunk faster. Both are
        asserted below, because a test showing only one would leave the other
        looking like a contradiction.
        """
        sizes = (400, 250, 200, 100, 50)
        multiples = [expected_pot_share(SIMPLE, "KC", opponents_alive=n).ev for n in sizes]
        assert multiples == sorted(multiples, reverse=True), multiples

        # The same numbers as a plain fraction of the pot: ev / (N + E).
        fractions = [ev / (n + 1) for ev, n in zip(multiples, sizes)]
        assert fractions == sorted(fractions), fractions

    def test_the_trend_goes_lumpy_once_the_field_is_smaller_than_the_rounding(self):
        """And it is the apportionment doing it, not a bug.

        Below about fifty opponents a team's whole-entry count stops tracking
        its share closely: KC is a 55% pick, but against ten opponents it holds
        6 of them (60%) and against four it holds 2 (50%). So the multiple
        stops falling monotonically -- it is answering a question about a
        differently-crowded board each time.

        This is worth a test rather than a caveat because it is exactly the
        regime the last few weeks of a pool are played in, and a reader who
        saw the ordering break there would reasonably suspect the model.
        """
        crowding = [
            expected_pot_share(SIMPLE, "KC", opponents_alive=n).opponent_share
            for n in (10, 4)
        ]
        assert crowding == [0.55, 0.55], "the input share is unchanged"

        ten = expected_pot_share(SIMPLE, "KC", opponents_alive=10).ev
        four = expected_pot_share(SIMPLE, "KC", opponents_alive=4).ev
        assert four > ten, "fewer entries on KC at N=4 makes the pick less crowded"


class TestRanking:
    def test_it_orders_best_first_and_breaks_ties_stably(self):
        ranked = rank_by_pot_share(SIMPLE, ["KC", "BUF", "SF", "PHI"], opponents_alive=200)
        assert [r.ev for r in ranked] == sorted([r.ev for r in ranked], reverse=True)
        again = rank_by_pot_share(SIMPLE, ["PHI", "SF", "BUF", "KC"], opponents_alive=200)
        assert [r.team for r in ranked] == [r.team for r in again], "order must not depend on input order"

    def test_a_team_not_playing_is_refused_rather_than_scored(self):
        with pytest.raises(ValueError):
            expected_pot_share(SIMPLE, "SEA", opponents_alive=200)
