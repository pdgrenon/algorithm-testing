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
from scripts.backtest import (
    PAIR_STRATEGIES,
    _mode_of,
    _one_field_holding,
    _run_seasons,
    _warn_ignored,
    build_parser,
    run_field,
)
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


class TestOneEntryRunningOut:
    """It must not take the other one with it."""

    def test_an_entry_with_nothing_playable_does_not_kill_its_partner(self):
        """The bug this is here for, constructed rather than waited for.

        `pair_pot_share` returned None for the whole holding as soon as any
        one entry had no playable team left, and the harness reads None as
        elimination. So an entry with a full inventory was eliminated because
        its partner had run dry -- which on a 32-team board is unreachable,
        and stops being unreachable the moment a game is dropped for having
        no price.
        """
        by_week, outcomes, _ = season(13)
        run = run_field(by_week, outcomes, 41)
        week = 1
        candidates = run.candidates[week]
        playing = sorted({t for t, _ in candidates})
        context = {
            "popularity": field_model.popularity_from_inventories(
                run.inventories[week], candidates
            ),
            "terminal_field": 1,
            "opponents_alive": len(run.inventories[week]),
            "week": week,
        }
        # Entry 0 has spent every team on the board; entry 1 has spent none.
        picks = PAIR_STRATEGIES["potshare"](
            by_week[week], None, week, [list(playing), []], context
        )
        assert picks[0] is None, "the exhausted entry is out"
        assert picks[1] is not None, "and the other one is not"
        assert picks[1] in playing

    def test_both_exhausted_is_still_both_out(self):
        by_week, outcomes, _ = season(13)
        run = run_field(by_week, outcomes, 41)
        candidates = run.candidates[1]
        playing = sorted({t for t, _ in candidates})
        context = {
            "popularity": field_model.popularity_from_inventories(
                run.inventories[1], candidates
            ),
            "terminal_field": 1,
            "opponents_alive": 248,
            "week": 1,
        }
        picks = PAIR_STRATEGIES["potshare"](
            by_week[1], None, 1, [list(playing), list(playing)], context
        )
        assert picks == [None, None]


class TestSplittingSeasonsAcrossCores:
    """Exact, not approximate -- the same arithmetic on a different core."""

    def _payloads(self, jobs):
        tags = list(range(6))
        names = sorted(PAIR_STRATEGIES)
        return {
            p["tag"]: p
            for p in _run_seasons(tags, names, [], fields=1, synthetic=6, jobs=jobs)
        }

    def test_four_processes_give_the_same_answers_as_one(self):
        """The whole licence for the --jobs flag.

        Every part of a season is deterministic given its tag and seed -- the
        generator, the field, and all four strategies -- so a worker computes
        the identical numbers. If this ever failed, every measurement would
        depend on how many cores happened to be free.
        """
        serial = self._payloads(1)
        parallel = self._payloads(4)
        assert serial.keys() == parallel.keys()
        for tag in serial:
            assert serial[tag] == parallel[tag], f"season {tag} differs"

    def test_every_season_comes_back_exactly_once(self):
        # imap preserves order and drops nothing; a lost or duplicated season
        # would move a mean without moving anything that looks wrong.
        tags = [p["tag"] for p in _run_seasons(
            list(range(9)), ["distinct"], [], fields=1, synthetic=9, jobs=4,
        )]
        assert tags == list(range(9))

    def test_the_per_strategy_counters_stay_per_strategy(self):
        """`wins`, `same` and `picked` are properties of a run, not a season.

        Folding them together across strategies would report one number four
        times -- and `twice` twinning on every week while the others never do
        is exactly the signal that would vanish.
        """
        payload = self._payloads(1)[0]
        assert payload["same"]["twice"] == payload["picked"]["twice"]
        for name in ("distinct", "joint", "potshare"):
            assert payload["same"][name] == 0, name


class TestTheCliSaysWhenAFlagDoesNothing:
    """A flag that is silently ignored makes the record of a run wrong.

    deadpool/src/engine/measured.js records the command that produced the
    ratings the app prints beside each strategy, and it carries `--pot-share`.
    `--entries 2` returns before `--pot-share` is ever looked at, so that flag
    has never done anything on that path. The figures are right -- they were
    re-derived from this harness -- and the command implies a switch that was
    not part of producing them.

    The sample size below is an example, not a quotation. This docstring used
    to name the published command as `--synthetic 2500`, which went stale the
    moment that table was re-run at 10,000 seasons. What this test pins is the
    parser's behaviour on the *shape* of that command; how many seasons the
    published run used is measured.js's business to state, in one place.

    Warned rather than refused: erasing the flag from a published command would
    make the record wrong the other way, and a harness that dies over a
    redundant argument is worse than one that says so.
    """

    def parse(self, argv):
        parser = build_parser()
        return parser.parse_args(argv), parser.parse_args([])

    def test_the_published_command_is_told_that_pot_share_does_nothing(self, capsys):
        args, defaults = self.parse(["--entries", "2", "--pot-share", "--synthetic", "2500"])
        assert _mode_of(args) == "holdings"
        assert _warn_ignored(args, defaults, "holdings") == ["pot_share"]
        assert "will have no effect" in capsys.readouterr().err

    def test_a_command_with_nothing_redundant_is_silent(self, capsys):
        args, defaults = self.parse(["--entries", "2", "--synthetic", "2500", "--fields", "10"])
        assert _warn_ignored(args, defaults, _mode_of(args)) == []
        assert capsys.readouterr().err == ""

    def test_every_report_reads_the_options_that_select_it(self, capsys):
        """Whatever chose the mode must never be reported as ignored."""
        for argv, mode in (
            (["--robustness"], "robustness"),
            (["--entries", "2"], "holdings"),
            (["--pot-share"], "pot_share"),
            (["--compare-win-prob"], "compare"),
            ([], "weeks"),
        ):
            args, defaults = self.parse(argv)
            assert _mode_of(args) == mode, argv
            assert _warn_ignored(args, defaults, mode) == [], f"{argv} warned about its own switch"
        capsys.readouterr()

    def test_the_single_entry_reports_disown_the_pair_options(self, capsys):
        args, defaults = self.parse(["--pot-share", "--pairs", "distinct", "--starts", "3"])
        assert _warn_ignored(args, defaults, _mode_of(args)) == ["pairs", "starts"]
        capsys.readouterr()

    def test_passing_a_flag_its_own_default_is_not_a_warning(self, capsys):
        # Nobody is relying on a setting they did not change, and reporting it
        # would make the warning noise rather than signal.
        args, defaults = self.parse(["--entries", "2", "--fields", "25"])
        assert _warn_ignored(args, defaults, "holdings") == []
        capsys.readouterr()
