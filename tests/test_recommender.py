from data.models import Game, Odds, Team, WinProbability
from picker.recommender import find_conflicts, rank_candidates, recommend_for_entries


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
        home=Team(abbreviation=home_abbr, display_name="Kansas City Chiefs"),
        away=Team(abbreviation=away_abbr, display_name="Denver Broncos"),
        probability=probability,
        odds=odds,
    )


class TestWinPctScale:
    def test_api_probability_is_reported_on_0_100_scale(self):
        # ESPN's raw field is a 0-1 fraction (0.78 == 78%); candidates must
        # come back on a 0-100 scale so the CLI's "{win_pct:.1f}%" is correct.
        game = make_game(home_win_pct=0.78, away_win_pct=0.22)
        candidates = rank_candidates([game], used_teams=[])
        kc = next(c for c in candidates if c.team_abbreviation == "KC")
        assert kc.win_pct == 78.0
        assert kc.win_pct_is_estimated is False

    def test_spread_fallback_is_flagged_as_estimated(self):
        game = make_game(spread=-6.5, spread_details="KC -6.5")
        candidates = rank_candidates([game], used_teams=[])
        kc = next(c for c in candidates if c.team_abbreviation == "KC")
        assert kc.win_pct is not None
        assert kc.win_pct > 50.0
        assert kc.win_pct_is_estimated is True


class TestRankCandidates:
    def test_excludes_used_teams(self):
        game = make_game(home_win_pct=0.6, away_win_pct=0.4)
        candidates = rank_candidates([game], used_teams=["KC"])
        assert all(c.team_abbreviation != "KC" for c in candidates)

    def test_excludes_non_pregame_games(self):
        game = make_game(state="in", home_win_pct=0.9, away_win_pct=0.1)
        candidates = rank_candidates([game], used_teams=[])
        assert candidates == []

    def test_sorts_by_win_pct_descending(self):
        favorite = make_game(event_id="1", home_abbr="KC", away_abbr="DEN", home_win_pct=0.8, away_win_pct=0.2)
        toss_up = make_game(event_id="2", home_abbr="SF", away_abbr="DAL", home_win_pct=0.5, away_win_pct=0.5)
        candidates = rank_candidates([favorite, toss_up], used_teams=[])
        assert candidates[0].team_abbreviation == "KC"


class TestFindConflicts:
    def test_flags_when_both_entries_top_pick_matches(self):
        game = make_game(home_win_pct=0.8, away_win_pct=0.2)
        recs = recommend_for_entries([game], {"Entry A": [], "Entry B": []})
        assert find_conflicts(recs) == "KC"

    def test_no_conflict_when_top_picks_differ(self):
        recs = {
            "Entry A": [type("C", (), {"team_abbreviation": "KC"})()],
            "Entry B": [type("C", (), {"team_abbreviation": "SF"})()],
        }
        assert find_conflicts(recs) is None
