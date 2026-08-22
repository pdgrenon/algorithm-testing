from data.models import Game, Odds, Team, WinProbability
from models.win_prob import TeamWeekWinProbability
from strategy.entry_a_value import (
    ENTRY_NAME,
    FUTURE_VALUE_PENALTY_SCALE,
    MAX_FUTURE_VALUE_PENALTY,
    RankedPick,
    rank_available_teams,
    recommend,
)


def make_game(
    event_id="1",
    week=3,
    state="pre",
    home_abbr="KC",
    away_abbr="DEN",
    home_win_pct=None,
    away_win_pct=None,
    spread=None,
    spread_details=None,
):
    probability = None
    if home_win_pct is not None or away_win_pct is not None:
        probability = WinProbability(home_win_pct=home_win_pct, away_win_pct=away_win_pct)
    odds = Odds(spread=spread, details=spread_details) if spread is not None else None
    return Game(
        event_id=event_id,
        competition_id=event_id,
        week=week,
        season_year=2026,
        state=state,
        home=Team(abbreviation=home_abbr, display_name=home_abbr),
        away=Team(abbreviation=away_abbr, display_name=away_abbr),
        probability=probability,
        odds=odds,
    )


def wp(team, week, win_pct):
    return TeamWeekWinProbability(
        team_abbreviation=team,
        week=week,
        season_year=2026,
        opponent_abbreviation="OPP",
        is_home=True,
        win_pct=win_pct,
        source="api",
    )


class TestRankAvailableTeams:
    def test_excludes_used_teams(self):
        game = make_game(home_win_pct=0.6, away_win_pct=0.4)
        ranked = rank_available_teams([game], {}, used_teams=["KC"], current_week=3)
        assert all(p.team_abbreviation != "KC" for p in ranked)

    def test_excludes_non_pregame(self):
        game = make_game(state="in", home_win_pct=0.9, away_win_pct=0.1)
        ranked = rank_available_teams([game], {}, used_teams=[], current_week=3)
        assert ranked == []

    def test_no_future_matchup_means_no_penalty(self):
        game = make_game(home_win_pct=0.9, away_win_pct=0.1, spread=-10, spread_details="KC -10")
        ranked = rank_available_teams([game], {}, used_teams=[], current_week=3)
        kc = next(p for p in ranked if p.team_abbreviation == "KC")
        assert kc.future_value_penalty == 0.0
        assert kc.score == 90.0

    def test_better_future_matchup_lowers_score_and_can_change_ranking(self):
        # KC: great matchup now (90%), nothing better coming up.
        # SF: good matchup now (80%), but a near-lock (99.9%) is coming next
        # week (distance 1, so barely discounted) -- future_value is well
        # past FUTURE_VALUE_PENALTY_SCALE, so the penalty hits its cap.
        game = make_game(
            event_id="1", week=3, home_abbr="KC", away_abbr="DEN", home_win_pct=0.9, away_win_pct=0.1
        )
        game2 = make_game(
            event_id="2", week=3, home_abbr="SF", away_abbr="DAL", home_win_pct=0.8, away_win_pct=0.2
        )
        win_prob_table = {("SF", 4): wp("SF", 4, 99.9)}

        ranked = rank_available_teams([game, game2], win_prob_table, used_teams=[], current_week=3)

        sf = next(p for p in ranked if p.team_abbreviation == "SF")
        kc = next(p for p in ranked if p.team_abbreviation == "KC")
        assert sf.future_value_penalty == MAX_FUTURE_VALUE_PENALTY
        assert sf.score == 80.0 * (1 - MAX_FUTURE_VALUE_PENALTY)
        assert ranked[0].team_abbreviation == "KC"  # KC's 90 beats SF's discounted score
        assert kc.score > sf.score

    def test_penalty_never_exceeds_cap_even_for_huge_future_value(self):
        game = make_game(home_win_pct=0.5, away_win_pct=0.5)
        win_prob_table = {("KC", 4): wp("KC", 4, 100.0)}
        ranked = rank_available_teams([game], win_prob_table, used_teams=[], current_week=3)
        kc = next(p for p in ranked if p.team_abbreviation == "KC")
        assert kc.future_value_penalty <= MAX_FUTURE_VALUE_PENALTY

    def test_team_with_no_win_pct_sorts_last(self):
        no_data_game = make_game(event_id="1", home_abbr="KC", away_abbr="DEN")
        scored_game = make_game(event_id="2", home_abbr="SF", away_abbr="DAL", home_win_pct=0.5, away_win_pct=0.5)
        ranked = rank_available_teams([no_data_game, scored_game], {}, used_teams=[], current_week=3)
        assert ranked[-1].score is None


class TestRecommend:
    def test_returns_top_pick_with_reasoning_mentioning_win_prob_and_spread(self):
        game = make_game(home_win_pct=0.78, away_win_pct=0.22, spread=-6.5, spread_details="KC -6.5")
        result = recommend([game], {}, current_week=3, used_teams=[])

        assert result.pick.team_abbreviation == "KC"
        assert "78.0%" in result.reasoning
        assert "KC -6.5" in result.reasoning

    def test_reasoning_explains_why_it_beats_the_alternative(self):
        game1 = make_game(event_id="1", home_abbr="KC", away_abbr="DEN", home_win_pct=0.8, away_win_pct=0.2)
        game2 = make_game(event_id="2", home_abbr="SF", away_abbr="DAL", home_win_pct=0.6, away_win_pct=0.4)
        result = recommend([game1, game2], {}, current_week=3, used_teams=[])

        assert result.pick.team_abbreviation == "KC"
        assert "Next best" in result.reasoning
        assert "SF" in result.reasoning

    def test_no_eligible_teams_returns_none_pick_with_explanation(self):
        game = make_game(home_win_pct=0.9, away_win_pct=0.1)
        result = recommend([game], {}, current_week=3, used_teams=["KC", "DEN"])
        assert result.pick is None
        assert "No eligible" in result.reasoning

    def test_defaults_used_teams_to_entry_a_state_file(self, tmp_path, monkeypatch):
        import strategy.entry_a_value as entry_a_value

        monkeypatch.setattr(entry_a_value, "load_used_teams_for_entry", lambda entry: ["KC"])
        game = make_game(home_win_pct=0.9, away_win_pct=0.1)

        result = entry_a_value.recommend([game], {}, current_week=3)

        assert result.pick.team_abbreviation == "DEN"  # KC excluded via the (mocked) state file
