"""One strategy for both entries, forbidden from landing on the same team.

Parity holds the port to the Python; these hold the Python to its own claims.
The interesting cases are the ones the fixtures cannot be relied on to
contain: a forced collision, an entry with nothing left, and the promise that
the order is fixed rather than incidental.
"""
import pytest

from data.models import Game, Odds, Team
from models.win_prob import build_win_probability_table
from strategy import distinct


def game(event_id, home, away, home_ml, away_ml, week=1):
    return Game(
        event_id=event_id, competition_id=event_id, week=week, season_year=2026,
        state="pre",
        home=Team(abbreviation=home, display_name=home),
        away=Team(abbreviation=away, display_name=away),
        probability=None,
        odds=Odds(home_moneyline=home_ml, away_moneyline=away_ml),
    )


# One overwhelming favourite, so both entries want it unless told otherwise.
BOARD = [
    game("1", "KC", "DEN", -2000, 1000),
    game("2", "BUF", "NYJ", -400, 320),
    game("3", "SF", "ARI", -300, 240),
    game("4", "PHI", "NYG", -200, 170),
]
TABLE = build_win_probability_table(BOARD)
A, B = distinct.ENTRY_A_NAME, distinct.ENTRY_B_NAME


def run(used_a=(), used_b=()):
    return distinct.recommend(
        BOARD, TABLE, 1,
        used_teams_by_entry={A: list(used_a), B: list(used_b)},
    )


class TestTheOneRule:
    def test_two_entries_never_get_the_same_team(self):
        """The entire point, on a board built to violate it.

        Both entries have full inventories and one team is far and away the
        best, so an uncoordinated strategy hands it to both.
        """
        out = run()
        teams = [p.team_abbreviation for p in out.picks.values() if p]
        assert len(teams) == 2
        assert len(set(teams)) == 2, f"both entries got {teams}"

    def test_the_first_entry_keeps_its_own_choice(self):
        # The order is fixed rather than searched, so A is unaffected by B
        # existing at all. Anything else would make A's pick depend on a
        # second entry it knows nothing about.
        paired = run().picks[A].team_abbreviation
        alone = distinct.recommend(
            BOARD, TABLE, 1, used_teams_by_entry={A: []}, entry_order=(A,),
        ).picks[A].team_abbreviation
        assert paired == alone

    def test_the_second_entry_is_the_one_recorded_as_moving(self):
        out = run()
        assert out.collided == [B], out.collided

    def test_nothing_is_recorded_as_moving_when_they_already_disagree(self):
        """Which is the honest answer to "is this different from running the
        underlying strategy twice this week" -- usually, no."""
        out = run(used_b=["KC"])   # B cannot want KC, so no collision arises
        assert out.collided == []
        assert out.picks[A].team_abbreviation == "KC"
        assert out.picks[B].team_abbreviation != "KC"


class TestInventories:
    def test_each_entry_keeps_its_own_history(self):
        # The exclusion is this week's picks only. A team A spent in Week 3 is
        # not thereby forbidden to B.
        out = run(used_a=["KC", "BUF"])
        assert out.picks[A].team_abbreviation not in {"KC", "BUF"}
        assert out.picks[B].team_abbreviation == "KC", "B never spent KC"

    def test_an_entry_with_nothing_left_does_not_take_the_other_down(self):
        # The failure mode found by reading pair_pot_share: one entry running
        # out returning None for the whole holding.
        everything = [t for g in BOARD for t in (g.home.abbreviation, g.away.abbreviation)]
        out = run(used_a=everything)
        assert out.picks[A] is None
        assert out.picks[B] is not None

    def test_both_exhausted_is_both_none(self):
        everything = [t for g in BOARD for t in (g.home.abbreviation, g.away.abbreviation)]
        out = run(used_a=everything, used_b=everything)
        assert out.picks[A] is None and out.picks[B] is None
        assert out.collided == []


class TestItIsDeterministic:
    def test_the_same_inputs_give_the_same_answer(self):
        first, second = run(), run()
        assert {e: (p.team_abbreviation if p else None) for e, p in first.picks.items()} == \
               {e: (p.team_abbreviation if p else None) for e, p in second.picks.items()}
        assert first.collided == second.collided

    def test_more_than_two_entries_still_all_differ(self):
        # Nothing in the rule is about there being exactly two, and a pool
        # allowing three would otherwise silently pair the last two up.
        c = "Entry C"
        out = distinct.recommend(
            BOARD, TABLE, 1,
            used_teams_by_entry={A: [], B: [], c: []}, entry_order=(A, B, c),
        )
        teams = [p.team_abbreviation for p in out.picks.values() if p]
        assert len(teams) == 3 and len(set(teams)) == 3, teams
