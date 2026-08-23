"""Two entries, scored together.

The load-bearing tests are the two at the top: this must reduce exactly to the
single-entry function at E=1, and it must agree with brute-force enumeration.
Everything below them is a property that was measured rather than assumed --
including one that came out the opposite way round from the docstring that
shipped with the first draft.
"""
import random
from itertools import product

import pytest

from models.joint_pot_share import expected_pot_share_holding, rank_holdings
from models.pot_share_ev import WeekGame, expected_pot_share
from models.payout import pot_share


def board(rows):
    return [WeekGame(h, a, p, sh, sa) for h, a, p, sh, sa in rows]


def random_board(rng, n):
    weights = [rng.expovariate(1.0) for _ in range(2 * n)]
    total = sum(weights)
    shares = [w / total for w in weights]
    return [
        WeekGame(f"H{i}", f"A{i}", rng.uniform(0.5, 0.95), shares[2 * i], shares[2 * i + 1])
        for i in range(n)
    ]


# A slate with one dominant favourite carrying most of the field, which is what
# a real Week 1 looks like.
SLATE = board([
    ("KC", "DEN", 0.88, 0.42, 0.005), ("BUF", "NYJ", 0.80, 0.18, 0.01),
    ("SF", "ARI", 0.76, 0.11, 0.01),  ("BAL", "CLE", 0.74, 0.07, 0.01),
    ("PHI", "NYG", 0.71, 0.05, 0.01), ("DET", "CHI", 0.68, 0.03, 0.01),
    ("GB", "MIN", 0.60, 0.015, 0.01), ("HOU", "IND", 0.58, 0.01, 0.01),
    ("MIA", "NE", 0.55, 0.005, 0.005), ("LAC", "LV", 0.62, 0.005, 0.005),
])
ALL_TEAMS = [t for g in SLATE for t in (g.home, g.away)]


class TestItReducesToTheSingleEntryFunction:
    """One entry is not a special case, it is the same calculation."""

    @pytest.mark.parametrize("team", ["KC", "BUF", "SF", "DEN", "LV"])
    def test_one_entry_matches_pot_share_ev_exactly(self, team):
        joint = expected_pot_share_holding(SLATE, [team], 250).ev
        single = expected_pot_share(SLATE, team, opponents_alive=250).ev
        assert joint == pytest.approx(single, rel=1e-12), team

    def test_it_still_matches_on_random_boards_and_small_fields(self):
        rng = random.Random(23)
        for _ in range(8):
            games = random_board(rng, rng.randint(3, 7))
            team = f"H{rng.randrange(len(games))}"
            for n in (250, 40, 6, 1):
                joint = expected_pot_share_holding(games, [team], n).ev
                single = expected_pot_share(games, team, opponents_alive=n).ev
                assert joint == pytest.approx(single, rel=1e-12), f"{team} at N={n}"


class TestItAgreesWithBruteForce:
    def test_two_entries_match_enumeration_over_every_outcome(self):
        """The convolution is only over games you have no stake in, so the
        oracle has to enumerate everything, yours included."""
        rng = random.Random(5)
        games = random_board(rng, 6)
        counts = None
        for pair in (("H0", "H1"), ("H0", "A0"), ("H2", "H2"), ("A4", "H5")):
            fast = expected_pot_share_holding(games, list(pair), 60).ev
            slow = _enumerate_holding(games, list(pair), 60)
            assert fast == pytest.approx(slow, rel=1e-12), pair


def _enumerate_holding(games, teams, opponents_alive):
    """Every outcome of every game, explicitly. 2^G, so keep the board small."""
    from models.pot_share_ev import _entry_counts

    counts = _entry_counts(games, opponents_alive)
    stakes = []
    for team in teams:
        for idx, g in enumerate(games):
            if team == g.home:
                stakes.append((idx, True))
                break
            if team == g.away:
                stakes.append((idx, False))
                break
    entries = len(teams)
    total = opponents_alive + entries
    ev = 0.0
    for outcome in product((True, False), repeat=len(games)):
        prob = 1.0
        survivors = 0
        for idx, home in enumerate(outcome):
            p = games[idx].home_win_prob
            prob *= p if home else 1.0 - p
            survivors += counts[idx][0] if home else counts[idx][1]
        if prob == 0.0:
            continue
        alive = sum(1 for idx, is_home in stakes if outcome[idx] == is_home)
        if alive == 0:
            continue
        ev += prob * alive / (alive + min(opponents_alive, survivors))
    return ev * total / entries


class TestWhatNMeans:
    """The finding that reversed the first draft's docstring."""

    def test_against_the_whole_field_it_says_double_up(self):
        """Written expecting the opposite, and the measurement said no.

        The argument was from convexity: two entries split one pot, so the
        second survivor is worth less than the first and the model should
        prefer to spread. Against 250 opponents your two entries are 0.8% of
        the denominator, so that convexity is almost nothing, and what is left
        is that a second survivor really is a second share.
        """
        best = rank_holdings(SLATE, [ALL_TEAMS, ALL_TEAMS], 250, limit=1)[0]
        assert best.teams == ("KC", "KC"), best.teams

        doubled = expected_pot_share_holding(SLATE, ["KC", "KC"], 250).ev
        split = expected_pot_share_holding(SLATE, ["KC", "BUF"], 250).ev
        assert doubled > split

    def test_against_the_field_you_finish_with_it_spreads(self):
        """And this is the N to actually pass.

        `expected_perfect_entries()` is 0.87 out of 250, so the field you split
        with at the end is about one. That is where diversification pays, and
        the same function without any new rule now puts doubling up well down
        the list.
        """
        best = rank_holdings(SLATE, [ALL_TEAMS, ALL_TEAMS], 1, limit=1)[0]
        assert best.teams[0] != best.teams[1], best.teams

        doubled = expected_pot_share_holding(SLATE, ["KC", "KC"], 1).ev
        split = expected_pot_share_holding(SLATE, ["KC", "BUF"], 1).ev
        assert split > doubled

    def test_the_crossover_is_where_your_entries_stop_being_a_rounding_error(self):
        # Somewhere in single digits, and it moves with the board rather than
        # sitting at a constant -- which is why there is no threshold in the code.
        doubling_up = [
            rank_holdings(SLATE, [ALL_TEAMS, ALL_TEAMS], n, limit=1)[0]
            for n in (250, 100, 50, 20, 10, 5, 3, 1)
        ]
        same = [h.teams[0] == h.teams[1] for h in doubling_up]
        assert same[0] is True and same[-1] is False
        # It flips once and does not flip back.
        assert same == sorted(same, reverse=True), same


class TestTheTerminalPayoffIsWhereTheConcavityLives:
    def test_a_second_entry_is_worth_nothing_once_the_first_is_clear(self):
        """Why N at the end is the number that matters.

        Under deepest-splits, being the sole deepest entry pays the whole pot,
        and being the two deepest entries also pays the whole pot. So the
        second entry's marginal value collapses to zero exactly when the first
        one wins -- which is invisible to any one-week model.
        """
        field = {f"opp{i}": 11 for i in range(248)}
        clear = pot_share({**field, "A": 12, "B": 11}, ["A", "B"])
        both_clear = pot_share({**field, "A": 12, "B": 12}, ["A", "B"])
        assert clear == pytest.approx(1.0)
        assert both_clear == pytest.approx(1.0)
        assert both_clear - clear == pytest.approx(0.0), "the second entry bought nothing"

    def test_and_it_is_worth_something_when_you_are_tied_with_the_field(self):
        # The other side of it: tied at the field's depth, a second entry is
        # one more claim on a pot being split many ways.
        field = {f"opp{i}": 11 for i in range(248)}
        one = pot_share({**field, "A": 11, "B": 0}, ["A", "B"])
        two = pot_share({**field, "A": 11, "B": 11}, ["A", "B"])
        assert two > one


class TestNothingIsForbidden:
    """Three rules the optimiser this replaces enforced, none of them measured."""

    def test_both_entries_on_one_team_is_scored_rather_than_refused(self):
        h = expected_pot_share_holding(SLATE, ["KC", "KC"], 250)
        assert h.ev > 0
        assert h.survival[1] == pytest.approx(0.0), "they live and die together"
        assert h.survival[2] == pytest.approx(0.88)

    def test_opposite_sides_of_one_game_guarantees_exactly_one_survivor(self):
        h = expected_pot_share_holding(SLATE, ["KC", "DEN"], 250)
        assert h.survival[1] == pytest.approx(1.0)
        assert h.survival[0] == pytest.approx(0.0)
        assert h.survival[2] == pytest.approx(0.0)

    def test_a_hedge_that_costs_too_much_ranks_low_rather_than_being_banned(self):
        ranked = rank_holdings(SLATE, [ALL_TEAMS, ALL_TEAMS], 250)
        where = [i for i, h in enumerate(ranked) if h.teams == ("KC", "DEN")][0]
        assert where > len(ranked) // 4, "a guaranteed single survivor is expensive here"

    def test_a_pick_below_the_old_win_probability_floor_is_still_scored(self):
        # MIA at 55% would have been refused by the 65% floor outright.
        h = expected_pot_share_holding(SLATE, ["KC", "MIA"], 250)
        assert h.ev > 0


class TestRanking:
    def test_it_respects_each_entry_s_own_inventory(self):
        ranked = rank_holdings(SLATE, [["BUF", "SF"], ["BAL", "PHI"]], 250)
        assert {h.teams for h in ranked} == {
            ("BUF", "BAL"), ("BUF", "PHI"), ("SF", "BAL"), ("SF", "PHI"),
        }

    def test_it_orders_best_first_and_does_not_depend_on_input_order(self):
        forward = rank_holdings(SLATE, [["KC", "BUF", "SF"], ["BAL", "PHI"]], 250)
        assert [h.ev for h in forward] == sorted([h.ev for h in forward], reverse=True)
        backward = rank_holdings(SLATE, [["SF", "BUF", "KC"], ["PHI", "BAL"]], 250)
        assert [h.teams for h in forward] == [h.teams for h in backward]

    def test_survival_probabilities_sum_to_one(self):
        for pair in (("KC", "BUF"), ("KC", "KC"), ("KC", "DEN")):
            h = expected_pot_share_holding(SLATE, list(pair), 250)
            assert sum(h.survival) == pytest.approx(1.0)

    def test_a_team_not_playing_is_refused_rather_than_scored(self):
        with pytest.raises(ValueError):
            expected_pot_share_holding(SLATE, ["KC", "SEA"], 250)

    def test_an_empty_holding_is_refused(self):
        with pytest.raises(ValueError):
            expected_pot_share_holding(SLATE, [], 250)
