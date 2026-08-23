"""The last few weeks, where the arithmetic stops being gentle.

Promised in the Phase 2 plan and not written until now. Everything else in
this suite exercises a full field, where the numbers are smooth and every
strategy scores about the same. The endgame is where they come apart, and it
is also where the two things this repository gets wrong most easily live: a
unanimous field, and a week where everybody dies at once.
"""
import pytest

from models.joint_pot_share import expected_pot_share_holding, rank_holdings
from models.payout import pot_share, settle
from models.pot_share_ev import WeekGame, expected_pot_share

# Everybody left is on KC. You hold KC too, and a 78% alternative.
UNANIMOUS = [
    WeekGame("KC", "DEN", 0.85, 1.0, 0.0),
    WeekGame("BUF", "NYJ", 0.78, 0.0, 0.0),
]


class TestAUnanimousField:
    """The one board where the right answer is obvious and easy to get wrong."""

    def test_joining_a_unanimous_field_is_capped_at_your_win_probability(self):
        """And therefore always worse than fair.

        If everyone is on the same team, then conditional on it winning
        everyone survives, so your share of the pot is exactly what it was
        before you played. The multiple is your win probability and nothing
        else -- 0.85 here, which is *below* 1.00. There is no board on which
        following a unanimous field is a good pick; the only question is
        whether the alternative is worse.
        """
        joined = expected_pot_share(UNANIMOUS, "KC", opponents_alive=250)
        assert joined.ev == pytest.approx(0.85, rel=1e-12)
        assert joined.ev < 1.0

    def test_fading_a_unanimous_field_is_worth_many_times_the_chalk(self):
        # 0.78 to win, and the 15% where the field is wiped out is worth the
        # entire pot. Against 250 opponents that is 35 times the chalk.
        joined = expected_pot_share(UNANIMOUS, "KC", opponents_alive=250).ev
        faded = expected_pot_share(UNANIMOUS, "BUF", opponents_alive=250).ev
        assert faded / joined > 30

    def test_and_the_bigger_the_field_the_more_fading_is_worth(self):
        """Because what you win when the field dies is the whole pot.

        This is the shape that makes a large pool unwinnable by playing chalk
        and winnable by not: the prize for being alone scales with how many
        people you were alone against.
        """
        ratios = [
            expected_pot_share(UNANIMOUS, "BUF", opponents_alive=n).ev
            / expected_pot_share(UNANIMOUS, "KC", opponents_alive=n).ev
            for n in (3, 10, 50, 250)
        ]
        assert ratios == sorted(ratios), ratios
        assert ratios[0] < 2 < ratios[-1]

    def test_a_thin_enough_field_makes_it_a_close_call_again(self):
        # Three opponents: taking the whole pot is worth four entries rather
        # than 251, so the 7-point price gap nearly pays for itself.
        joined = expected_pot_share(UNANIMOUS, "KC", opponents_alive=3).ev
        faded = expected_pot_share(UNANIMOUS, "BUF", opponents_alive=3).ev
        assert 1.0 < faded / joined < 1.5


class TestEverybodyDyingAtOnce:
    """The branch a one-week model scores as zero and the pool pays out on."""

    def test_a_week_that_kills_the_whole_field_is_a_draw_not_a_loss(self):
        """Ten entries on one team, and it loses.

        Under deepest-splits nobody is eliminated *relative to the field*, so
        all ten tie for deepest and all ten split. Any simulator that prunes
        the branch where your pick lost is unsound here, and it prunes it
        exactly when the branch is worth the most.
        """
        depths = {f"opp{i}": 11 for i in range(9)}
        depths["me"] = 11
        assert pot_share(depths, ["me"]) == pytest.approx(0.10)

        settled = settle(depths)
        assert settled["me"].depth == 11
        assert settled["me"].winners == 10
        assert not settled["me"].went_the_distance

    def test_surviving_a_week_that_killed_everyone_else_takes_the_lot(self):
        depths = {f"opp{i}": 11 for i in range(9)}
        depths["me"] = 12
        assert pot_share(depths, ["me"]) == pytest.approx(1.0)

    def test_dying_in_a_week_the_field_survived_is_worth_nothing(self):
        # The asymmetry that makes the above worth stating: it is only a draw
        # when everybody dies. One survivor and you have nothing.
        depths = {f"opp{i}": 12 for i in range(9)}
        depths["me"] = 11
        assert pot_share(depths, ["me"]) == pytest.approx(0.0)

    def test_two_entries_dying_together_still_split_with_the_field(self):
        depths = {f"opp{i}": 11 for i in range(8)}
        depths.update({"me0": 11, "me1": 11})
        # Ten entries at depth 11, two of them mine.
        assert pot_share(depths, ["me0", "me1"]) == pytest.approx(0.20)


class TestTwoEntriesInTheEndgame:
    def test_against_a_unanimous_field_the_pair_should_not_both_join(self):
        """Both on the chalk is capped at the chalk's win probability.

        Whatever the second entry is doing, it should not be buying another
        copy of a pick that cannot beat fair.
        """
        both_join = expected_pot_share_holding(UNANIMOUS, ["KC", "KC"], 250).ev
        one_each = expected_pot_share_holding(UNANIMOUS, ["KC", "BUF"], 250).ev
        assert one_each > both_join
        assert both_join == pytest.approx(0.85, rel=1e-12)

    def test_guaranteeing_a_survivor_is_what_wins_and_there_are_four_ways(self):
        """Written expecting KC/DEN to be uniquely best, and it is not.

        Covering both sides of the *field's* game looked like the special
        move: in the 15% where DEN wins, that entry lives alone against
        nobody. But BUF/NYJ scores identically to twelve decimal places, and
        the reason is that the opponents are entirely inside the KC game
        either way -- so all any holding can do is guarantee itself a survivor
        and let the field's fate be decided without it.

        All four ways of covering a game tie at the top. That is the general
        statement, and it is more useful than the one about KC/DEN, because it
        says the hedge does not need to be aimed at the crowd.
        """
        covering = [["KC", "DEN"], ["DEN", "KC"], ["BUF", "NYJ"], ["NYJ", "BUF"]]
        scores = [expected_pot_share_holding(UNANIMOUS, c, 250) for c in covering]
        for h in scores:
            assert h.survival[1] == pytest.approx(1.0), h.teams
        best = scores[0].ev
        for h in scores[1:]:
            assert h.ev == pytest.approx(best, rel=1e-12), h.teams

        teams = ["KC", "DEN", "BUF", "NYJ"]
        ranked = rank_holdings(UNANIMOUS, [teams, teams], 250)
        assert {tuple(c) for c in covering} == {h.teams for h in ranked[:4]}

    def test_doubling_up_on_the_chalk_is_the_worst_holding_on_the_board(self):
        # Sixteen holdings, and the one the field is unanimously on comes
        # last. Not merely beatable -- last, by a factor of five.
        teams = ["KC", "DEN", "BUF", "NYJ"]
        ranked = rank_holdings(UNANIMOUS, [teams, teams], 250)
        assert ranked[-1].teams == ("KC", "KC")
        assert ranked[-1].ev * 5 < ranked[-2].ev
