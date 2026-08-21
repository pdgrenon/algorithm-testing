import pytest

from data.models import Game, Odds, Team, WinProbability
from strategy.joint_optimizer import (
    DEFAULT_MIN_WIN_PROB_FLOOR_B,
    build_team_options,
    find_best_pair,
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


# Three independent games, so there's room for valid A/B pairs across all tests.
GAME_1 = make_game(event_id="1", home_abbr="KC", away_abbr="DEN", home_win_pct=0.9, away_win_pct=0.1)
GAME_2 = make_game(event_id="2", home_abbr="SF", away_abbr="DAL", home_win_pct=0.75, away_win_pct=0.25)
GAME_3 = make_game(event_id="3", home_abbr="BUF", away_abbr="NYJ", home_win_pct=0.6, away_win_pct=0.4)
THREE_GAMES = [GAME_1, GAME_2, GAME_3]


class TestBuildTeamOptions:
    def test_includes_both_teams_per_game(self):
        options = build_team_options([GAME_1])
        abbrevs = {o.team_abbreviation for o in options}
        assert abbrevs == {"KC", "DEN"}

    def test_excludes_non_pregame(self):
        started = make_game(state="in", home_win_pct=0.9, away_win_pct=0.1)
        assert build_team_options([started]) == []


class TestFindBestPair:
    def test_never_repeats_used_team_for_either_entry(self):
        search = find_best_pair(THREE_GAMES, used_teams_a=["KC"], used_teams_b=[], min_win_prob_floor_b=0.0)
        assert search.best.pick_a.team_abbreviation != "KC"

    def test_never_same_team_for_both_entries(self):
        search = find_best_pair(THREE_GAMES, used_teams_a=[], used_teams_b=[], min_win_prob_floor_b=0.0)
        assert search.best.pick_a.team_abbreviation != search.best.pick_b.team_abbreviation

    def test_never_opposing_sides_of_same_game(self):
        # Only one game available -- no valid pair should exist.
        search = find_best_pair([GAME_1], used_teams_a=[], used_teams_b=[], min_win_prob_floor_b=0.0)
        assert search.best is None
        assert search.pairs_considered == 0

    def test_picks_maximize_the_combined_objective(self):
        # KC 90%, SF 75%, BUF 60% (favorites); best pair should be KC+SF.
        search = find_best_pair(THREE_GAMES, used_teams_a=[], used_teams_b=[], min_win_prob_floor_b=0.0)
        picked = {search.best.pick_a.team_abbreviation, search.best.pick_b.team_abbreviation}
        assert picked == {"KC", "SF"}

    def test_objective_formula_matches_p_a_plus_p_b_minus_both_lose(self):
        search = find_best_pair([GAME_1, GAME_2], used_teams_a=[], used_teams_b=[], min_win_prob_floor_b=0.0)
        pair = search.best
        p_a, p_b = pair.pick_a.win_pct / 100.0, pair.pick_b.win_pct / 100.0
        expected_objective = p_a + p_b - (1 - p_a) * (1 - p_b)
        assert pair.objective_score == pytest.approx(expected_objective)

    def test_probabilities_sum_to_100(self):
        search = find_best_pair([GAME_1, GAME_2], used_teams_a=[], used_teams_b=[], min_win_prob_floor_b=0.0)
        pair = search.best
        total = pair.both_survive_pct + pair.one_survives_pct + pair.both_eliminated_pct
        assert total == pytest.approx(100.0)

    def test_floor_excludes_low_probability_b_candidates(self):
        # BUF/NYJ are the only <65% options; with a 65% floor B should never land there
        # unless forced.
        search = find_best_pair(THREE_GAMES, used_teams_a=[], used_teams_b=[], min_win_prob_floor_b=65.0)
        assert search.best.pick_b.win_pct >= 65.0
        assert search.floor_relaxed is False

    def test_floor_relaxed_when_nothing_clears_it_for_b(self):
        # Force B to only have access to a below-floor team by using up everything else.
        used_teams_b = ["KC", "DEN", "SF", "DAL"]
        search = find_best_pair(THREE_GAMES, used_teams_a=[], used_teams_b=used_teams_b, min_win_prob_floor_b=65.0)
        assert search.floor_relaxed is True
        assert search.best is not None

    def test_default_floor_is_65_percent(self):
        assert DEFAULT_MIN_WIN_PROB_FLOOR_B == 65.0

    def test_no_valid_pairs_returns_none_best(self):
        search = find_best_pair([], used_teams_a=[], used_teams_b=[])
        assert search.best is None
        assert search.pairs_considered == 0

    def test_runner_up_is_not_the_same_pair_with_entries_swapped(self):
        # KC (90%) and SF (75%) are each other's best cross-game partner in
        # both directions, so (KC,SF) and (SF,KC) score identically -- the
        # runner-up should skip that swap and surface a genuinely different
        # pairing (something involving BUF/NYJ) instead of reporting a tie
        # with itself.
        search = find_best_pair(THREE_GAMES, used_teams_a=[], used_teams_b=[], min_win_prob_floor_b=0.0)
        best_teams = {search.best.pick_a.team_abbreviation, search.best.pick_b.team_abbreviation}
        assert best_teams == {"KC", "SF"}
        runner_up_teams = {search.runner_up.pick_a.team_abbreviation, search.runner_up.pick_b.team_abbreviation}
        assert runner_up_teams != best_teams


class TestRecommend:
    def test_returns_reasoning_with_both_picks_and_probabilities(self):
        result = recommend(THREE_GAMES, current_week=3, used_teams_a=[], used_teams_b=[], min_win_prob_floor_b=0.0)
        assert result.pick_a is not None and result.pick_b is not None
        assert "Entry A: KC" in result.reasoning
        assert "both survive" in result.reasoning
        assert "both eliminated" in result.reasoning

    def test_reasoning_explains_runner_up_comparison(self):
        result = recommend(THREE_GAMES, current_week=3, used_teams_a=[], used_teams_b=[], min_win_prob_floor_b=0.0)
        assert "next-best combination" in result.reasoning

    def test_no_valid_pair_returns_none_picks_with_explanation(self):
        result = recommend([GAME_1], current_week=3, used_teams_a=[], used_teams_b=[])
        assert result.pick_a is None
        assert result.pick_b is None
        assert "No valid pick pair" in result.reasoning

    def test_defaults_used_teams_to_state_files(self, monkeypatch):
        import strategy.joint_optimizer as joint_optimizer

        def fake_loader(entry):
            return ["KC"] if entry == "Entry A" else []

        monkeypatch.setattr(joint_optimizer, "load_used_teams_for_entry", fake_loader)
        result = joint_optimizer.recommend(THREE_GAMES, current_week=3, min_win_prob_floor_b=0.0)
        assert result.pick_a.team_abbreviation != "KC"
