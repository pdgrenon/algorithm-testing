import pytest

from models.future_value import (
    DEFAULT_DECAY_RATE,
    compute_future_value,
    compute_future_value_for_team,
    shadow_price,
    shadow_prices,
)
from models.win_prob import TeamWeekWinProbability


def wp(week, win_pct, team="KC"):
    return TeamWeekWinProbability(
        team_abbreviation=team,
        week=week,
        season_year=2026,
        opponent_abbreviation="OPP",
        is_home=True,
        win_pct=win_pct,
        source="api",
    )


class TestComputeFutureValue:
    def test_better_matchup_soon_yields_positive_future_value(self):
        # Weak matchup this week (55%), a much easier one two weeks out (90%).
        schedule = [wp(4, 60.0), wp(5, 90.0), wp(6, 65.0)]
        result = compute_future_value("KC", current_week=3, current_week_win_pct=55.0, remaining_schedule=schedule)

        assert result.best_future_week == 5
        assert result.best_future_win_pct == 90.0
        assert result.future_value is not None
        assert result.future_value > 0
        assert result.should_hold is True

    def test_best_matchup_is_now_yields_nonpositive_future_value(self):
        # This week's matchup (90%) is better than anything coming up.
        schedule = [wp(4, 55.0), wp(5, 50.0)]
        result = compute_future_value("KC", current_week=3, current_week_win_pct=90.0, remaining_schedule=schedule)

        assert result.future_value is not None
        assert result.future_value <= 0
        assert result.should_hold is False

    def test_decay_reduces_far_out_matchups(self):
        # A 95% matchup 6 weeks out should be discounted enough that a solid
        # 80% matchup next week still wins out as "best".
        schedule = [wp(4, 80.0), wp(9, 95.0)]  # week 9 is outside default 6-week lookahead
        result = compute_future_value("KC", current_week=3, current_week_win_pct=50.0, remaining_schedule=schedule)

        assert result.best_future_week == 4
        assert result.best_future_win_pct == 80.0

    def test_decay_weight_applied_correctly(self):
        schedule = [wp(5, 100.0)]  # 2 weeks out from current_week=3
        result = compute_future_value("KC", current_week=3, current_week_win_pct=0.0, remaining_schedule=schedule)

        expected_weight = DEFAULT_DECAY_RATE ** (2 - 1)
        assert result.best_future_weighted_win_pct == 100.0 * expected_weight

    def test_ignores_past_and_current_week_entries(self):
        schedule = [wp(1, 99.0), wp(3, 99.0), wp(4, 60.0)]
        result = compute_future_value("KC", current_week=3, current_week_win_pct=50.0, remaining_schedule=schedule)
        assert result.best_future_week == 4

    def test_respects_lookahead_window(self):
        schedule = [wp(10, 99.0)]
        result = compute_future_value(
            "KC", current_week=3, current_week_win_pct=50.0, remaining_schedule=schedule, lookahead_weeks=4
        )
        assert result.best_future_week is None
        assert result.future_value is None

    def test_bye_week_entry_with_no_win_pct_is_skipped_not_zero(self):
        schedule = [wp(4, None), wp(5, 70.0)]
        result = compute_future_value("KC", current_week=3, current_week_win_pct=50.0, remaining_schedule=schedule)
        assert result.best_future_week == 5

    def test_missing_current_week_win_pct_still_reports_best_future(self):
        schedule = [wp(4, 70.0)]
        result = compute_future_value("KC", current_week=3, current_week_win_pct=None, remaining_schedule=schedule)
        assert result.best_future_week == 4
        assert result.future_value is None  # nothing to compare against

    def test_no_candidates_returns_empty_result(self):
        result = compute_future_value("KC", current_week=3, current_week_win_pct=50.0, remaining_schedule=[])
        assert result.best_future_week is None
        assert result.future_value is None
        assert result.should_hold is False


class TestComputeFutureValueForTeam:
    def test_pulls_schedule_from_win_prob_table(self):
        table = {
            ("KC", 3): wp(3, 55.0),
            ("KC", 4): wp(4, 60.0),
            ("KC", 5): wp(5, 90.0),
            ("DEN", 3): wp(3, 40.0, team="DEN"),
        }
        result = compute_future_value_for_team(table, "KC", current_week=3)
        assert result.current_week_win_pct == 55.0
        assert result.best_future_week == 5
        assert result.future_value > 0

    def test_team_not_in_table_has_no_current_win_pct(self):
        table = {("KC", 4): wp(4, 60.0)}
        result = compute_future_value_for_team(table, "KC", current_week=3)
        assert result.current_week_win_pct is None
        assert result.best_future_week == 4


class TestTheHorizonBoundaries:
    """Which weeks count as "future", which the docstring is specific about
    and nothing held. Both edges survived a mutation: the lower one could be
    moved to include the current week itself, and a tie could be resolved to
    the later week, with the whole suite still green.
    """

    def test_this_week_is_not_its_own_future(self):
        # `remaining_schedule` "only needs to contain entries after
        # current_week; anything at or before it is ignored". A caller handing
        # in the whole table -- which strategy/entry_a_value.py nearly does --
        # would otherwise compare this week against itself and read a hold
        # signal off a week already in hand.
        schedule = [wp(3, 95.0), wp(2, 99.0), wp(4, 60.0)]
        result = compute_future_value("KC", current_week=3, current_week_win_pct=50.0,
                                      remaining_schedule=schedule)
        assert result.best_future_week == 4, "week 3 and week 2 are not ahead of week 3"
        assert [w for w, _ in result.weekly_weighted] == [4]

    def test_the_last_week_in_the_window_still_counts(self):
        schedule = [wp(9, 90.0)]
        result = compute_future_value("KC", current_week=3, current_week_win_pct=50.0,
                                      remaining_schedule=schedule, lookahead_weeks=6)
        assert result.best_future_week == 9, "current_week + lookahead_weeks is inside the window"

    def test_one_week_past_the_window_does_not(self):
        schedule = [wp(10, 90.0)]
        result = compute_future_value("KC", current_week=3, current_week_win_pct=50.0,
                                      remaining_schedule=schedule, lookahead_weeks=6)
        assert result.best_future_week is None
        assert result.future_value is None

    def test_a_tie_on_weighted_value_goes_to_the_earlier_week(self):
        """Two weeks worth exactly the same after decay.

        The earlier one is the answer: it is the spot actually reached first,
        and holding a team for the later of two identical spots is strictly
        worse. `future_value` is the same either way, so nothing downstream
        would have noticed the week being wrong.
        """
        # 80 at distance 1 weighs 80.0; 80/0.85 at distance 2 weighs 80.0 too.
        later = 80.0 / DEFAULT_DECAY_RATE
        result = compute_future_value("KC", current_week=3, current_week_win_pct=50.0,
                                      remaining_schedule=[wp(4, 80.0), wp(5, later)])
        assert result.best_future_weighted_win_pct == pytest.approx(80.0)
        assert result.best_future_week == 4, "the tie is resolved to the week that comes first"


class TestShadowPrice:
    """The dual variable, and the half of it nothing reached.

    `shadow_prices` (plural) is what strategy/sequence_dp.py calls, and its
    behaviour is held by tests/test_sequence_dp.py. `shadow_price` -- the
    single-team form the module is written around and the docstrings explain --
    has no caller in the repository, so reversing its subtraction outright, and
    ordering the plural version cheapest-first against its own "highest first",
    both left everything green.
    """

    # A toy objective: an inventory is worth the sum of its teams' values, so
    # every price is knowable in advance and the arithmetic is not the thing
    # under test.
    VALUES = {"KC": 5.0, "BUF": 3.0, "SF": 3.0, "NYJ": 0.0}

    def value_of(self, inventory):
        return sum(self.VALUES[t] for t in inventory)

    def test_it_is_what_spending_the_team_costs(self):
        full = set(self.VALUES)
        assert shadow_price(self.value_of, full, "KC") == pytest.approx(5.0)
        assert shadow_price(self.value_of, full, "NYJ") == pytest.approx(0.0)

    def test_the_sign_is_the_loss_not_the_gain(self):
        # Backwards it reads -5.0 for the most valuable team in the inventory,
        # which the caller would rank last precisely because it is worth most.
        full = set(self.VALUES)
        assert shadow_price(self.value_of, full, "KC") > 0
        assert shadow_price(self.value_of, full, "KC") > shadow_price(self.value_of, full, "BUF")

    def test_a_team_not_in_the_inventory_costs_nothing(self):
        assert shadow_price(self.value_of, {"KC", "BUF"}, "SF") == pytest.approx(0.0)

    def test_it_does_not_mutate_the_inventory_it_was_given(self):
        full = set(self.VALUES)
        shadow_price(self.value_of, full, "KC")
        assert full == set(self.VALUES), "pricing a team is not spending it"

    def test_interchangeable_teams_price_the_same(self):
        assert (shadow_price(self.value_of, set(self.VALUES), "BUF")
                == pytest.approx(shadow_price(self.value_of, set(self.VALUES), "SF")))


class TestShadowPrices:
    VALUES = {"KC": 5.0, "BUF": 3.0, "SF": 1.0, "NYJ": 0.0}

    def value_of(self, inventory):
        return sum(self.VALUES[t] for t in inventory)

    def test_every_team_agrees_with_the_single_form(self):
        full = set(self.VALUES)
        table = shadow_prices(self.value_of, full)
        for team in full:
            assert table[team] == pytest.approx(shadow_price(self.value_of, full, team))

    def test_it_is_ordered_most_expensive_first(self):
        table = shadow_prices(self.value_of, set(self.VALUES))
        assert list(table) == ["KC", "BUF", "SF", "NYJ"]

    def test_a_tie_is_broken_by_name_so_the_order_is_stable(self):
        values = {"ZZZ": 2.0, "AAA": 2.0, "MMM": 9.0}
        table = shadow_prices(lambda inv: sum(values[t] for t in inv), set(values))
        assert list(table) == ["MMM", "AAA", "ZZZ"]

    def test_it_evaluates_the_baseline_once_rather_than_per_team(self):
        """|S| + 1 evaluations, which the docstring claims and nothing counted."""
        calls = []

        def counting(inventory):
            calls.append(frozenset(inventory))
            return self.value_of(inventory)

        inventory = set(self.VALUES)
        shadow_prices(counting, inventory)
        assert len(calls) == len(inventory) + 1
        assert calls.count(frozenset(inventory)) == 1, "the full inventory is priced once"
