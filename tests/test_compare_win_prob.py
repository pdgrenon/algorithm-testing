"""The before/after replay, which had stopped being able to run at all.

`scripts/backtest.py --compare-win-prob` replays the season under three
configurations of the source ladder by monkeypatching two functions in
`models/win_prob.py`. That is the right shape -- a second copy of the engine is
the thing that drifts and then proves nothing -- but a stand-in is only honest
while it can be *called* the way the real one is, and that half did drift:
`resolve_team_win_probability` grew a de-vig method and a tie rule, the
replacements kept their old two- and three-argument shapes, and every
configuration raised TypeError on the first priced game.

Nothing caught it because the only thing that runs this path downloads twenty
seasons of results first. These tests do not: they drive the patched engine
over one hand-built game, which is enough to prove all three rungs are
reachable and that the module is left as it was found.
"""
import pytest

from data.models import Game, Odds, Team
from models import win_prob
from models.win_prob import resolve_team_win_probability
from scripts import backtest


def priced_game() -> Game:
    """One game with both a spread and a pair of moneylines, so every rung fires."""
    return Game(
        event_id="x", competition_id="x", week=1, season_year=2024, state="pre",
        home=Team(abbreviation="KC"), away=Team(abbreviation="DEN"),
        probability=None,
        odds=Odds(spread=-6.5, home_moneyline=-280, away_moneyline=230),
    )


@pytest.fixture
def configurations(monkeypatch):
    """What each of the three configurations scores one game at, in order.

    `run` is replaced so nothing fetches: the point is which function the
    resolver reaches, not how long an entry lasted.
    """
    seen = []

    def record(seasons, rows, names, verbose, starts=1):
        resolved = resolve_team_win_probability(priced_game(), True)
        seen.append((resolved.source, resolved.win_pct))

    monkeypatch.setattr(backtest, "run", record)
    backtest.compare_win_prob([2024], [], ["ranked"], starts=1)
    return seen


class TestEveryConfigurationScores:
    def test_all_three_run(self, configurations):
        assert len(configurations) == 3

    def test_the_two_earlier_rungs_reach_the_spread(self, configurations):
        # Before the moneyline rung existed, a priced game was scored off the
        # spread. Both of the first two configurations turn moneylines off, so
        # both must land there -- and land on *different* numbers, or the
        # middle row is not separating the two changes it exists to separate.
        (first_source, first), (second_source, second), _ = configurations
        assert first_source == "spread_estimate"
        assert second_source == "spread_estimate"
        assert first != second

    def test_the_old_rule_is_still_the_linear_one(self, configurations):
        # 50 + 6.5 * 1.2 = 57.8, with no tie folded in. If this ever comes back
        # as something else, the "before" row is describing an engine that
        # never shipped and the comparison is worthless.
        assert configurations[0][1] == pytest.approx(57.8)

    def test_the_last_configuration_is_the_shipped_engine(self, configurations):
        source, value = configurations[-1]
        assert source == "moneyline"
        assert value == pytest.approx(
            win_prob.win_pct_from_moneylines(-280, 230, True)
        )


def test_the_module_is_left_as_it_was_found(configurations):
    """The patch is undone, or every later report in the same process is wrong.

    `compare_win_prob` is one of several reports `main()` can run, and it runs
    before the ordinary replay does.
    """
    resolved = resolve_team_win_probability(priced_game(), True)
    assert resolved.source == "moneyline"


class TestTheGuardOnTheStandIns:
    """Why this cannot rot quietly again."""

    def test_a_stand_in_with_the_wrong_shape_is_refused(self):
        def two_args(spread, team_is_home):
            return None

        with pytest.raises(TypeError, match="stands in for"):
            backtest._same_shape(two_args, win_prob.estimate_win_pct_from_spread)

    def test_a_matching_shape_passes(self):
        def three_args(spread, team_is_home, tie_is_loss=False):
            return None

        backtest._same_shape(three_args, win_prob.estimate_win_pct_from_spread)

    def test_reordering_is_caught_too(self):
        # Same arity, different meaning. Counting arguments would let this
        # through and it would silently score every game backwards.
        def swapped(team_is_home, spread, tie_is_loss=False):
            return None

        with pytest.raises(TypeError, match="stands in for"):
            backtest._same_shape(swapped, win_prob.estimate_win_pct_from_spread)
