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

        # The three outcome percentages are deliberately NOT in here. Both
        # surfaces that show this prose already print them as their own row --
        # report.py builds an "Outcomes this week" line for the terminal and an
        # .outcome block for the HTML, and the web view renders them as factor
        # rows above the prose. Saying them again in the sentence underneath is
        # what turned this panel into a wall of text.
        #
        # Asserted as an absence, because the earlier version of this test
        # required the duplication and would have blocked the fix.
        assert "both survive" not in result.reasoning
        assert "both eliminated" not in result.reasoning
        # What it must still carry is the property the numbers cannot show on
        # their own: that one result cannot take out both entries.
        assert "one result cannot end both" in result.reasoning

    def test_reasoning_explains_runner_up_comparison(self):
        result = recommend(THREE_GAMES, current_week=3, used_teams_a=[], used_teams_b=[], min_win_prob_floor_b=0.0)
        # Which pairing it beat, without the objective scores behind it: that
        # it won 1.875 to 1.857 on a combined objective is not something a
        # reader can act on, and it was the longest clause in the sentence.
        assert "next-best pairing" in result.reasoning
        assert "combined objective" not in result.reasoning

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


class TestTheSameTeamGuardWithoutAnEventId:
    """`never the same team` rests on its own line, not on the game check.

    Removing `if a.team_abbreviation == b.team_abbreviation` left the whole
    suite green, because every fixture carries an event_id and the same-game
    check catches the same team as a side effect. It does not catch it when
    there is no id: `a.event_id is not None` is there on purpose, so two
    unidentified games are not collapsed into one, and that is exactly the
    board on which the same-team rule is the only thing left.

    A game with no id is not hypothetical -- espn.js falls back to the event
    id and nflverse.js synthesises one, so a payload missing both is a parse
    away.
    """

    def _board(self):
        # No event_id anywhere, and the strongest side is far ahead of the
        # rest, so doubling up on it is what an unguarded search would do.
        return [
            make_game(event_id=None, home_abbr="KC", away_abbr="DEN", home_win_pct=0.95, away_win_pct=0.05),
            make_game(event_id=None, home_abbr="SF", away_abbr="DAL", home_win_pct=0.70, away_win_pct=0.30),
        ]

    def test_both_entries_are_never_given_the_same_team(self):
        result = find_best_pair(self._board(), used_teams_a=[], used_teams_b=[], min_win_prob_floor_b=0.0)
        assert result.best is not None
        assert result.best.pick_a.team_abbreviation != result.best.pick_b.team_abbreviation

    def test_the_objective_would_otherwise_prefer_doubling_up(self):
        """Why the guard has to be there rather than fall out of the scoring.

        `p_a + p_b - (1 - p_a)(1 - p_b)` is highest when both entries take the
        best team: 2*0.95 - 0.05^2 beats 0.95 + 0.70 - 0.05*0.30. The search
        is not declining that pair on score; it is refusing to consider it.
        """
        options = {o.team_abbreviation: o for o in build_team_options(self._board())}
        p = options["KC"].win_pct / 100.0
        q = options["SF"].win_pct / 100.0
        doubled = p + p - (1 - p) * (1 - p)
        split = p + q - (1 - p) * (1 - q)
        assert doubled > split

    def test_recommend_holds_the_same_line(self):
        rec = recommend(self._board(), current_week=3, used_teams_a=[], used_teams_b=[],
                        min_win_prob_floor_b=0.0)
        assert rec.pick_a is not None and rec.pick_b is not None
        assert rec.pick_a.team_abbreviation != rec.pick_b.team_abbreviation
