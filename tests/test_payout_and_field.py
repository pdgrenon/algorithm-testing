"""The pool: how the pot is settled, and how the simulated field behaves.

Several of these are the specific bugs the algorithm spec's own checklist
names as the ones that silently produce plausible-looking wrong answers.
They are written so a failure names the mistake rather than a number.
"""
import random

import pytest

from models.payout import (
    DEFAULT_POOL_SIZE,
    expected_perfect_entries,
    fair_share,
    pot_share,
    settle,
    value_of,
)
from scripts import field as fm


class TestDeepestSplits:
    def test_the_pot_is_never_left_unclaimed(self):
        """The whole reason this rule exists.

        The clean "1/n if you went 18-0" function returns zero for everybody in
        the modal season, which wastes every simulated path that reaches it.
        This one always pays somebody.
        """
        depths = {"a": 7, "b": 4, "c": 2}
        assert sum(p.share for p in settle(depths).values()) == pytest.approx(1.0)

    def test_only_the_deepest_are_paid_and_they_split_evenly(self):
        depths = {"a": 11, "b": 11, "c": 10, "d": 3}
        out = settle(depths)
        assert out["a"].share == pytest.approx(0.5)
        assert out["b"].share == pytest.approx(0.5)
        assert out["c"].share == 0.0, "one week short is worth nothing"
        assert out["d"].share == 0.0

    def test_a_perfect_season_is_the_same_rule_not_a_special_case(self):
        depths = {"a": 18, "b": 18, "c": 17}
        out = settle(depths)
        assert out["a"].share == pytest.approx(0.5)
        assert out["a"].went_the_distance is True
        assert out["c"].share == 0.0

    def test_nobody_perfect_is_the_expected_ending_at_this_field_size(self):
        # 0.87 expected unbeaten entries out of 250. Below one, so the deepest
        # -splits branch is the normal ending rather than an edge case, and
        # this is the number that says so.
        assert expected_perfect_entries(DEFAULT_POOL_SIZE) < 1.0

    def test_a_fair_entry_is_worth_exactly_the_buy_in(self):
        assert value_of(fair_share()) == pytest.approx(10.0)


class TestYourEntriesAreInTheDenominator:
    """The spec's checklist item 3, and it can be got wrong two ways."""

    def test_holding_two_entries_counts_as_two(self):
        # Three entries tie at the deepest week and two of them are yours, so
        # you take two thirds -- not one third, and not one half.
        depths = {"mine-a": 9, "mine-b": 9, "theirs": 9, "other": 4}
        assert pot_share(depths, ["mine-a", "mine-b"]) == pytest.approx(2 / 3)

    def test_a_dead_entry_of_yours_adds_nothing(self):
        depths = {"mine-a": 9, "mine-b": 3, "theirs": 9}
        assert pot_share(depths, ["mine-a", "mine-b"]) == pytest.approx(0.5)

    def test_the_field_includes_you(self):
        pool = fm.build_field(250, ["mine-a", "mine-b"])
        assert len(pool) == 250, "your entries take two of the 250 seats"
        assert "mine-a" in pool and "mine-b" in pool


class TestTheFieldBehaves:
    def test_an_opponent_never_picks_the_same_team_twice(self):
        # Checklist item 8: inventories not carried forward gives late-season
        # fields unrealistic availability, and it is invisible in aggregate.
        rng = random.Random(1)
        opponent = fm.Opponent(entry_id="o")
        board = [("KC", 90.0), ("BUF", 85.0), ("PHI", 80.0)]
        outcomes = {(w, t): "win" for w in range(1, 4) for t, _ in board}
        for week in range(1, 4):
            fm.advance(opponent, board, outcomes, week, rng)
        assert len(opponent.used) == 3, f"reused a team: {opponent.used}"

    def test_running_out_of_teams_ends_a_run_rather_than_pausing_it(self):
        rng = random.Random(1)
        opponent = fm.Opponent(entry_id="o", used={"KC"})
        outcomes = {(1, "KC"): "win"}
        fm.advance(opponent, [("KC", 90.0)], outcomes, 1, rng)
        assert opponent.alive is False

    def test_concentration_is_what_tau_controls(self):
        # Checklist item 5 in spirit: the weights are a distribution over what
        # is *available*, so they must renormalise rather than leak mass.
        board = [("KC", 90.0), ("BUF", 80.0), ("PHI", 70.0), ("NYJ", 55.0)]
        sharp = fm.pick_weights(board, fm.SHARP_TAU)
        casual = fm.pick_weights(board, fm.CASUAL_TAU)
        assert sharp[0] / sum(sharp) > casual[0] / sum(casual), (
            "a sharper field must concentrate harder on the best team"
        )
        for weights in (sharp, casual):
            assert sum(weights) > 0
            assert all(w >= 0 for w in weights)

    def test_slip_is_off_by_default_because_exhaustion_already_explains_the_rate(self):
        """Measured: the field reaches the historical survival rate unaided.

        A field picking favourites survives at 83% in any one week, and the
        historical public figure is 73%. The gap closes on its own once teams
        are consumed -- an entry cannot keep taking the chalk it spent in
        September. Turning slip up now pushes the field *below* the historical
        rate rather than toward it.
        """
        assert fm.DEFAULT_SLIP == 0.0
        assert fm.CHALK_WEEKLY_SURVIVAL > fm.TARGET_WEEKLY_SURVIVAL
        assert abs(fm.MODELLED_WEEKLY_SURVIVAL - fm.TARGET_WEEKLY_SURVIVAL) < 0.02

    def test_a_slipped_entry_still_picks_something_legal(self):
        rng = random.Random(4)
        board = [("KC", 90.0), ("BUF", 80.0)]
        for _ in range(50):
            assert fm.choose(board, rng, fm.CASUAL_TAU, slip=1.0) in {"KC", "BUF"}


class TestScheduleShape:
    def test_every_team_plays_seventeen_of_eighteen_weeks(self):
        """Checklist item 7, and item 2 by implication.

        An off-by-one around byes is invisible: the board still renders, the
        picks still look sensible, and one team is quietly pickable on a week
        it is not playing. Checked against real schedule data rather than a
        fixture, because this is a fact about the NFL and not about the app.
        """
        import sys
        from pathlib import Path

        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from scripts.backtest import CACHE, games_for_season, load_rows

        if not CACHE.exists():
            pytest.skip("nflverse results not cached; run scripts/backtest.py once")

        by_week = games_for_season(load_rows(), 2023)
        weeks_for: dict[str, int] = {}
        for week, games in by_week.items():
            for game in games:
                for side in (game.home, game.away):
                    weeks_for[side.abbreviation] = weeks_for.get(side.abbreviation, 0) + 1

        assert len(weeks_for) == 32, f"expected 32 teams, got {len(weeks_for)}"
        assert set(weeks_for.values()) == {17}, (
            f"every team plays exactly 17 of 18 weeks; got {sorted(set(weeks_for.values()))}"
        )
