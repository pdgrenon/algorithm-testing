from data.models import Game, Odds, Team, WinProbability
from strategy.entry_b_hedge import (
    DEFAULT_MIN_WIN_PROB_FLOOR,
    meets_win_prob_floor,
    rank_hedge_candidates,
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


class TestMeetsWinProbFloor:
    def test_above_floor(self):
        assert meets_win_prob_floor(70.0, 65.0) is True

    def test_below_floor(self):
        assert meets_win_prob_floor(60.0, 65.0) is False

    def test_none_never_meets_floor(self):
        assert meets_win_prob_floor(None, 65.0) is False


class TestRankHedgeCandidates:
    def test_excludes_used_teams(self):
        game = make_game(home_win_pct=0.9, away_win_pct=0.1)
        ranked, _ = rank_hedge_candidates([game], used_teams=["KC"])
        assert all(c.team_abbreviation != "KC" for c in ranked)

    def test_excludes_non_pregame(self):
        game = make_game(state="in", home_win_pct=0.9, away_win_pct=0.1)
        ranked, _ = rank_hedge_candidates([game], used_teams=[])
        assert ranked == []

    def test_excludes_entry_a_game_entirely(self):
        entry_a_game = make_game(event_id="1", home_abbr="KC", away_abbr="DEN", home_win_pct=0.9, away_win_pct=0.1)
        other_game = make_game(event_id="2", home_abbr="SF", away_abbr="DAL", home_win_pct=0.7, away_win_pct=0.3)
        ranked, _ = rank_hedge_candidates(
            [entry_a_game, other_game], used_teams=[], exclude_event_id="1", min_win_prob_floor=0.0
        )
        abbrevs = {c.team_abbreviation for c in ranked}
        assert abbrevs == {"SF", "DAL"}

    def test_floor_filters_out_low_probability_teams(self):
        favorite = make_game(event_id="1", home_abbr="KC", away_abbr="DEN", home_win_pct=0.9, away_win_pct=0.1)
        ranked, relaxed = rank_hedge_candidates([favorite], used_teams=[], min_win_prob_floor=65.0)
        abbrevs = {c.team_abbreviation for c in ranked}
        assert "DEN" not in abbrevs  # 10% doesn't clear the floor
        assert "KC" in abbrevs
        assert relaxed is False

    def test_floor_relaxed_when_nothing_clears_it(self):
        toss_up = make_game(home_win_pct=0.5, away_win_pct=0.5)
        ranked, relaxed = rank_hedge_candidates([toss_up], used_teams=[], min_win_prob_floor=65.0)
        assert relaxed is True
        assert len(ranked) == 2  # fell back to the unfiltered ranking

    def test_no_candidates_at_all_is_not_a_relaxed_floor(self):
        ranked, relaxed = rank_hedge_candidates([], used_teams=[])
        assert ranked == []
        assert relaxed is False


class TestRecommend:
    def test_top_pick_includes_win_prob_and_spread_in_reasoning(self):
        game = make_game(home_win_pct=0.78, away_win_pct=0.22, spread=-6.5, spread_details="KC -6.5")
        result = recommend([game], current_week=3, used_teams=[])
        assert result.pick.team_abbreviation == "KC"
        assert "78.0%" in result.reasoning
        assert "KC -6.5" in result.reasoning

    def test_reasoning_mentions_hedge_against_entry_a(self):
        entry_a_game = make_game(event_id="1", home_abbr="KC", away_abbr="DEN", home_win_pct=0.9, away_win_pct=0.1)
        other_game = make_game(event_id="2", home_abbr="SF", away_abbr="DAL", home_win_pct=0.7, away_win_pct=0.3)
        result = recommend(
            [entry_a_game, other_game], current_week=3, used_teams=[], entry_a_pick_team="KC"
        )
        assert result.pick.team_abbreviation == "SF"
        assert "Avoided Entry A's game" in result.reasoning

    def test_no_hedge_context_ranks_by_win_pct_only(self):
        game = make_game(home_win_pct=0.9, away_win_pct=0.1)
        result = recommend([game], current_week=3, used_teams=[])
        assert result.pick.team_abbreviation == "KC"
        assert "Avoided" not in result.reasoning

    def test_floor_relaxation_is_reported_in_reasoning(self):
        toss_up = make_game(home_win_pct=0.5, away_win_pct=0.5)
        result = recommend([toss_up], current_week=3, used_teams=[], min_win_prob_floor=65.0)
        assert result.floor_relaxed is True
        assert "No available team cleared" in result.reasoning

    def test_no_eligible_teams_returns_none_pick(self):
        game = make_game(home_win_pct=0.9, away_win_pct=0.1)
        result = recommend([game], current_week=3, used_teams=["KC", "DEN"])
        assert result.pick is None
        assert "No eligible" in result.reasoning

    def test_defaults_used_teams_to_entry_b_state_file(self, monkeypatch):
        import strategy.entry_b_hedge as entry_b_hedge

        monkeypatch.setattr(entry_b_hedge, "load_used_teams_for_entry", lambda entry: ["KC"])
        game = make_game(home_win_pct=0.9, away_win_pct=0.1)

        result = entry_b_hedge.recommend([game], current_week=3)

        assert result.pick.team_abbreviation == "DEN"
