from models.future_value import (
    DEFAULT_DECAY_RATE,
    compute_future_value,
    compute_future_value_for_team,
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
