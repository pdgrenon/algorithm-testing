"""The two-entry replay itself.

Nothing tested the harness, which is awkward for a harness whose whole job is
to be believed. These are the invariants the pair comparison rests on: that
sharing one simulated field across strategies is exact rather than merely
cheaper, that the field cannot see your picks, and that the two baselines do
the thing their names claim.

Runs on generated seasons rather than the nflverse download, so it needs no
cache and never fetches.
"""
import pytest

from models.win_prob import build_win_probability_table
from scripts import field as field_model
from scripts.backtest import PAIR_STRATEGIES, _one_field_holding, run_field
from scripts.synth import season

import math


@pytest.fixture(scope="module")
def board():
    by_week, outcomes, _ = season(11)
    table = build_win_probability_table(
        [g for w in sorted(by_week) for g in by_week[w]]
    )
    return by_week, outcomes, table


class TestSharingOneFieldIsExact:
    """The refactor's whole claim, and the reason it is allowed."""

    @pytest.mark.parametrize("name", sorted(PAIR_STRATEGIES))
    def test_a_shared_field_gives_the_same_answer_as_its_own(self, board, name):
        by_week, outcomes, table = board
        alone = _one_field_holding(
            by_week, outcomes, table, PAIR_STRATEGIES[name], seed=99
        )
        shared = _one_field_holding(
            by_week, outcomes, table, PAIR_STRATEGIES[name], seed=99,
            field_run=run_field(by_week, outcomes, 99),
        )
        assert alone == shared, name

    def test_the_field_does_not_depend_on_which_strategy_is_tested(self, board):
        """Why it is shareable at all.

        The opponents never see your entries, so their depths are a property
        of the seed. If this ever failed, every comparison in the harness
        would be against four different fields wearing one name.
        """
        by_week, outcomes, table = board
        depths = {
            name: _one_field_holding(
                by_week, outcomes, table, PAIR_STRATEGIES[name], seed=7
            )[2]
            for name in sorted(PAIR_STRATEGIES)
        }
        assert len(set(depths.values())) == 1, depths

    def test_a_different_seed_gives_a_different_field(self, board):
        by_week, outcomes, _ = board
        assert run_field(by_week, outcomes, 1).depths != run_field(by_week, outcomes, 2).depths

    def test_inventories_are_snapshotted_before_the_week_is_played(self, board):
        """Taking them after would hand the strategy next week's field.

        Week 1 is where it is unambiguous: nobody has picked anything yet, so
        every inventory has to be empty.
        """
        by_week, outcomes, _ = board
        run = run_field(by_week, outcomes, 3)
        assert all(not used for used in run.inventories[1])
        assert len(run.inventories[1]) == 248, "250 entries less the two held"
        # And by week 4 they are not, which is what makes the assertion above
        # about ordering rather than about the field being empty.
        assert any(used for used in run.inventories[4])


class TestTheBaselinesDoWhatTheyClaim:
    def test_running_one_strategy_twice_produces_two_identical_entries(self, board):
        by_week, outcomes, table = board
        *_, twinned, both_picked = _one_field_holding(
            by_week, outcomes, table, PAIR_STRATEGIES["twice"], seed=5
        )
        assert both_picked > 0, "the fixture has to get far enough to measure"
        assert twinned == both_picked, "that is the floor this is here to be"

    @pytest.mark.parametrize("name", ["distinct", "joint", "potshare"])
    def test_every_other_pairing_keeps_the_two_entries_apart(self, board, name):
        by_week, outcomes, table = board
        *_, twinned, both_picked = _one_field_holding(
            by_week, outcomes, table, PAIR_STRATEGIES[name], seed=5
        )
        assert both_picked > 0
        assert twinned == 0, f"{name} put both entries on one team"


class TestWhatTheStrategyIsTold:
    def test_the_belief_cannot_change_what_the_field_does(self, board):
        """The control that makes --robustness readable.

        Only the popularity forecast handed to the strategy moves; the
        opponents behave identically. So a strategy that never reads the
        forecast has to come out byte-identical, and one that does may not.
        """
        by_week, outcomes, table = board
        run = run_field(by_week, outcomes, 21)
        for name in ("twice", "distinct", "joint"):
            got = {
                _one_field_holding(
                    by_week, outcomes, table, PAIR_STRATEGIES[name], seed=21,
                    forecast_tau=belief, field_run=run,
                )
                for belief in (0.15, 0.35, 0.70)
            }
            assert len(got) == 1, f"{name} reacted to a forecast it does not read"

    def test_the_terminal_field_is_what_you_finish_against_not_what_is_alive(self):
        """One is 248 in Week 1 and the other is one, and it reverses the pick.

        See models/joint_pot_share.py -- passing the live field instead makes
        the pair search double up on the favourite.
        """
        early = field_model.terminal_field(248, 1)
        late = field_model.terminal_field(248, 17)
        assert early == 1, "0.73^17 of 248 is under one"
        assert late > early
        assert field_model.terminal_field(248, 18) == 248, "at the end, it is the field"

    def test_it_never_returns_zero_opponents(self):
        # Zero would make the pot yours whatever you pick, so every candidate
        # would score identically and the ranking would be arbitrary.
        for alive in (0, 1, 5, 250):
            for week in range(1, 19):
                assert field_model.terminal_field(alive, week) >= 1


class TestTheFieldsHotPath:
    """`_logit` is memoised, which is only allowed if it changes no arithmetic."""

    @pytest.mark.parametrize("p", [1e-9, 0.001, 0.01, 0.25, 0.5, 0.75, 0.99, 1 - 1e-9])
    def test_the_memo_returns_exactly_what_the_formula_gives(self, p):
        clamped = min(max(p, 1e-6), 1 - 1e-6)
        assert field_model._logit(p) == math.log(clamped / (1 - clamped))

    def test_clearing_the_memo_changes_nothing(self):
        candidates = [(f"T{i}", 50.0 + i * 1.3) for i in range(30)]
        before = field_model.pick_weights(candidates, 0.35)
        field_model._logit.cache_clear()
        after = field_model.pick_weights(candidates, 0.35)
        assert before == after

    def test_a_whole_field_run_is_unchanged_by_the_cache_state(self):
        """The property the speedup actually rests on.

        Every opponent alive in a week scores the same board, so the memo is
        hit 248 times per candidate -- which is where the time goes and why
        this is worth doing. It is only worth doing if the season that comes
        out is the same one.
        """
        by_week, outcomes, _ = season(12)
        warm = run_field(by_week, outcomes, 31).depths
        field_model._logit.cache_clear()
        cold = run_field(by_week, outcomes, 31).depths
        assert warm == cold
