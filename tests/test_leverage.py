"""`distinct`, plus the field — and the promise that it is exactly `distinct`
when there is no field to read.

The assertions worth the most here are the negative ones. This strategy sits on
top of the only result the harness has established at more than two standard
errors, and the whole shape was chosen so it cannot lose much: the downside is
bounded by a parameter, and with no sheet configured it must be the *same pick*,
not merely a similar one. Several tests below exist only to hold that.
"""
import pytest

from data.models import Game, Odds, Team
from models.win_prob import build_win_probability_table
from strategy import distinct, leverage


def game(event_id, home, away, home_ml, away_ml, week=1):
    return Game(
        event_id=event_id, competition_id=event_id, week=week, season_year=2026,
        state="pre",
        home=Team(abbreviation=home, display_name=home),
        away=Team(abbreviation=away, display_name=away),
        probability=None,
        odds=Odds(home_moneyline=home_ml, away_moneyline=away_ml),
    )


# Two teams within a couple of points of each other at the top, so the
# tolerance band has something in it, plus a clear drop to third.
BOARD = [
    game("1", "KC", "DEN", -600, 440),
    game("2", "BUF", "NYJ", -560, 420),
    game("3", "SF", "ARI", -300, 240),
    game("4", "PHI", "NYG", -200, 170),
]
TABLE = build_win_probability_table(BOARD)
A, B = leverage.ENTRY_A_NAME, leverage.ENTRY_B_NAME


def run(inventories=None, used_a=(), used_b=(), **kw):
    return leverage.recommend(
        BOARD, TABLE, 1,
        used_teams_by_entry={A: list(used_a), B: list(used_b)},
        field_inventories=inventories,
        **kw,
    )


def base(used_a=(), used_b=()):
    return distinct.recommend(
        BOARD, TABLE, 1,
        used_teams_by_entry={A: list(used_a), B: list(used_b)},
    )


def teams(rec):
    return {e: (p.team_abbreviation if p else None) for e, p in rec.picks.items()}


class TestItIsDistinctUntilThereIsAFieldToRead:
    """The safety property, four ways it could be absent."""

    @pytest.mark.parametrize("inventories", [None, {}, ], ids=["none", "empty"])
    def test_no_field_is_the_same_pick_not_a_similar_one(self, inventories):
        assert teams(run(inventories)) == teams(base())

    def test_a_field_that_has_spent_nothing_changes_nothing(self):
        # Every entry holds every team, so the forecast is the same shape as
        # the board and the most popular team is simply the best one -- which
        # is the team `distinct` already took. Nothing to move to.
        out = run({f"e{i}": [] for i in range(20)})
        assert out.picks[A].team_abbreviation == base().picks[A].team_abbreviation

    def test_zero_tolerance_pins_it_to_distinct(self):
        # The parameter is the whole of the downside, so setting it to nothing
        # must remove the behaviour rather than merely shrink it.
        crowded = {f"e{i}": ["SF", "PHI"] for i in range(20)}
        assert teams(run(crowded, tolerance_pct=0.0)) == teams(base())

    def test_a_board_with_no_probabilities_falls_through(self):
        blank = [
            Game(event_id="9", competition_id="9", week=1, season_year=2026, state="pre",
                 home=Team(abbreviation="KC", display_name="KC"),
                 away=Team(abbreviation="DEN", display_name="DEN"),
                 probability=None, odds=None),
        ]
        out = leverage.recommend(
            blank, build_win_probability_table(blank), 1,
            field_inventories={"e1": ["SF"]},
        )
        assert out.forecast == {}


class TestTheOneRuleStillHolds:
    """Whatever the field says, the two entries never land together."""

    def test_two_entries_never_get_the_same_team(self):
        # The field forecast is a second thing pulling on the pick, and the
        # failure it could introduce is walking both entries onto the same
        # under-owned team. This is the measurement the whole strategy is
        # built on top of; losing it would give back more than the field
        # signal could ever be worth.
        crowded = {f"e{i}": ["SF"] for i in range(30)}
        out = run(crowded)
        picked = [p.team_abbreviation for p in out.picks.values() if p]
        assert len(picked) == 2
        assert len(set(picked)) == 2, f"both entries got {picked}"

    def test_the_second_entry_cannot_take_what_the_first_moved_to(self):
        # A moves off its pick; B must not then be handed the team A moved to.
        # This is the case that only exists because of the switch, so nothing
        # in distinct's own suite covers it.
        for inv in ({f"e{i}": ["KC"] for i in range(20)},
                    {f"e{i}": ["BUF"] for i in range(20)},
                    {f"e{i}": ["KC", "BUF"] for i in range(20)}):
            out = run(inv)
            picked = [p.team_abbreviation for p in out.picks.values() if p]
            assert len(set(picked)) == len(picked), f"collision with {inv['e0']}: {picked}"

    def test_an_entry_with_nothing_left_is_left_alone(self):
        out = run({f"e{i}": ["SF"] for i in range(20)},
                  used_a=["KC", "BUF", "SF", "PHI", "DEN", "NYJ", "ARI", "NYG"])
        assert out.picks[A] is None


class TestItMovesWhenMovingIsFree:
    def test_it_leaves_a_team_the_whole_field_can_still_take(self):
        # Nobody has spent anything, so the field's weight follows the board
        # and concentrates on the best team. The second-best is within
        # tolerance, so the pick should move off the crowd.
        out = run({f"e{i}": [] for i in range(50)}, tolerance_pct=20.0)
        assert out.switched, "a wide tolerance over a concentrated field should move something"

    def test_it_prefers_a_team_the_field_has_already_spent(self):
        # Every survivor has burned KC, so none of them can take it this week:
        # its forecast share is 0 and it is the safest thing on the board that
        # nobody can follow you onto.
        spent_kc = {f"e{i}": ["KC"] for i in range(40)}
        out = run(spent_kc, tolerance_pct=20.0)
        assert out.picks[A].team_abbreviation == "KC"
        assert out.forecast.get("KC", 0.0) == 0.0

    def test_it_never_gives_up_more_than_the_tolerance(self):
        # The bound is the entire argument for this being safe to ship on top
        # of a measured result, so it is asserted directly rather than trusted
        # to the comparison inside least_crowded.
        for tol in (0.5, 2.0, 5.0):
            out = run({f"e{i}": ["KC"] for i in range(40)}, tolerance_pct=tol)
            before = base().picks[A]
            after = out.picks[A]
            assert after.win_pct >= before.win_pct - tol - 1e-9, (
                f"gave up {before.win_pct - after.win_pct:.2f} points at tolerance {tol}"
            )

    def test_a_switch_is_reported_with_both_teams(self):
        out = run({f"e{i}": ["KC"] for i in range(40)}, tolerance_pct=20.0)
        if out.switched:
            for entry, (was, now) in out.switched.items():
                assert was != now
                assert out.picks[entry].team_abbreviation == now

    def test_the_reasoning_says_what_it_traded(self):
        out = run({f"e{i}": ["KC"] for i in range(40)}, tolerance_pct=20.0)
        if out.switched:
            entry = next(iter(out.switched))
            assert "to advance" in out.reasoning[entry]
            assert "surviving entries" in out.reasoning[entry]


class TestDeterminism:
    def test_the_same_input_gives_the_same_answer(self):
        inv = {f"e{i}": ["KC" if i % 2 else "BUF"] for i in range(20)}
        assert teams(run(inv)) == teams(run(inv))

    def test_inventory_order_does_not_change_the_forecast(self):
        # dicts preserve insertion order and the forecast is a mean over
        # entries, so a reordered pool must not move the answer.
        a = {"x": ["KC"], "y": ["BUF"], "z": ["SF"]}
        b = {"z": ["SF"], "x": ["KC"], "y": ["BUF"]}
        fa = leverage.forecast_field(BOARD, a)
        fb = leverage.forecast_field(BOARD, b)
        assert fa.keys() == fb.keys()
        for k in fa:
            assert fa[k] == pytest.approx(fb[k], abs=1e-12)


class TestTheForecastItself:
    def test_a_team_no_survivor_can_take_is_absent_rather_than_zero(self):
        # Absent, not `0.0`. The same distinction `engine/field.js` holds for
        # `spentShare`: nobody being able to pick a team and the model saying
        # "we scored this at zero" are different statements, and only one of
        # them is true here -- the team never entered anybody's choice.
        # Callers read it through `.get(team, 0.0)`, which is where the zero
        # belongs.
        f = leverage.forecast_field(BOARD, {f"e{i}": ["KC"] for i in range(10)})
        assert "KC" not in f
        assert f.get("KC", 0.0) == 0.0

    def test_the_shares_sum_to_one(self):
        f = leverage.forecast_field(BOARD, {f"e{i}": [] for i in range(10)})
        assert sum(f.values()) == pytest.approx(1.0, abs=1e-9)

    def test_exhausting_the_field_pushes_weight_onto_what_is_left(self):
        # The mechanism the whole strategy rests on: spend the chalk and the
        # field is forced somewhere worse, which is knowable in advance.
        fresh = leverage.forecast_field(BOARD, {f"e{i}": [] for i in range(10)})
        spent = leverage.forecast_field(BOARD, {f"e{i}": ["KC", "BUF"] for i in range(10)})
        assert spent["SF"] > fresh["SF"]
