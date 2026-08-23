"""The multi-week sequence search.

The parity suite proves the JavaScript agrees with this; it says nothing about
whether either is correct. These are the properties that make it a plan rather
than a ranked list, written so a failure names the property rather than a
number.
"""
import pytest

from data.models import Game, Odds, Team
from models.win_prob import build_win_probability_table
from strategy import sequence_dp


def game(week, home, away, home_ml, away_ml, event_id=None, state="pre"):
    return Game(
        event_id=event_id or f"{week}-{home}-{away}",
        competition_id=event_id or f"{week}-{home}-{away}",
        week=week,
        season_year=2026,
        state=state,
        home=Team(abbreviation=home, display_name=home),
        away=Team(abbreviation=away, display_name=away),
        odds=Odds(home_moneyline=home_ml, away_moneyline=away_ml),
    )


def moneyline_for(prob):
    """An American price implying roughly `prob`, with no vig, for readable fixtures."""
    return -round(prob / (1 - prob) * 100) if prob >= 0.5 else round((1 - prob) / prob * 100)


def week_of(week, pairs):
    """pairs: [(home, away, home_win_prob)] -> games for that week."""
    return [
        game(week, home, away, moneyline_for(p), moneyline_for(1 - p))
        for home, away, p in pairs
    ]


class TestItPlansRatherThanRanks:
    def test_holds_a_team_back_when_a_better_week_needs_them(self):
        # KC is the best team available this week AND the only good option in
        # week 2. Taking them now leaves week 2 with nothing; the plan must
        # spend the interchangeable team first.
        #
        # This separates a plan from a pure ranking -- `ranked` takes KC and
        # strands week 2. It does not separate it from the future-value
        # heuristic, which happens to get this one right; the test below is the
        # case where that heuristic actually fails.
        this_week = week_of(1, [("KC", "DEN", 0.90), ("BUF", "NYJ", 0.88)])
        later = week_of(2, [("KC", "LV", 0.92), ("CHI", "GB", 0.51)])
        table = build_win_probability_table(this_week + later)

        r = sequence_dp.recommend(this_week, table, 1, used_teams=[], lookahead_weeks=2)

        assert r.pick.team_abbreviation == "BUF", (
            "took the single best team this week and stranded week 2 — "
            "that is the ranked strategy, not a plan"
        )
        assert [p.team_abbreviation for p in r.path] == ["BUF", "KC"]

    def test_beats_the_heuristic_where_the_heuristic_is_blind(self):
        """The failure `models/future_value.py` cannot see, by construction.

        It scores one team at a time, so it asks "is a better week coming for
        KC?" and answers yes, then asks the same of BUF and answers no -- and
        never asks the only question that matters, which is what covers *this*
        week if KC waits. Holding a team back only pays if the week they vacate
        is survivable, and here it barely is:

            KC then BUF   0.90 x 0.55 = 0.495
            BUF then KC   0.55 x 0.99 = 0.544

        The heuristic takes KC now and the search takes BUF, which is the
        better two-week plan. Note how close the numbers are: the point is the
        blind spot, not the margin.
        """
        this_week = week_of(1, [("KC", "DEN", 0.90), ("BUF", "NYJ", 0.55)])
        later = week_of(2, [("KC", "LV", 0.99), ("BUF", "MIA", 0.55)])
        table = build_win_probability_table(this_week + later)

        from strategy import entry_a_value

        heuristic = entry_a_value.recommend(this_week, table, 1, used_teams=[])
        planned = sequence_dp.recommend(this_week, table, 1, used_teams=[], lookahead_weeks=2)

        assert heuristic.pick.team_abbreviation == "KC"
        assert planned.pick.team_abbreviation == "BUF"
        assert [p.team_abbreviation for p in planned.path] == ["BUF", "KC"]

    def test_takes_the_best_when_nothing_is_contested(self):
        this_week = week_of(1, [("KC", "DEN", 0.90), ("BUF", "NYJ", 0.70)])
        later = week_of(2, [("PHI", "NYG", 0.88), ("SF", "SEA", 0.86)])
        table = build_win_probability_table(this_week + later)

        r = sequence_dp.recommend(this_week, table, 1, used_teams=[], lookahead_weeks=2)
        assert r.pick.team_abbreviation == "KC"

    def test_never_spends_a_team_twice_across_the_plan(self):
        weeks = []
        for w in range(1, 5):
            weeks += week_of(w, [("KC", "DEN", 0.9), ("BUF", "NYJ", 0.88), ("PHI", "NYG", 0.86)])
        table = build_win_probability_table(weeks)
        this_week = [g for g in weeks if g.week == 1]

        r = sequence_dp.recommend(this_week, table, 1, used_teams=[], lookahead_weeks=4)
        teams = [p.team_abbreviation for p in r.path]
        assert len(teams) == len(set(teams)), f"the plan reuses a team: {teams}"


class TestConstraints:
    def test_a_used_team_is_never_offered_or_planned(self):
        this_week = week_of(1, [("KC", "DEN", 0.95), ("BUF", "NYJ", 0.70)])
        later = week_of(2, [("KC", "LV", 0.96), ("CHI", "GB", 0.60)])
        table = build_win_probability_table(this_week + later)

        r = sequence_dp.recommend(this_week, table, 1, used_teams=["KC"], lookahead_weeks=2)
        assert r.pick.team_abbreviation == "BUF"
        assert "KC" not in [p.team_abbreviation for p in r.path]

    def test_a_game_already_under_way_is_not_pickable(self):
        started = game(1, "KC", "DEN", -900, 600, state="in")
        open_game = game(1, "BUF", "NYJ", -300, 250)
        table = build_win_probability_table([started, open_game])

        r = sequence_dp.recommend([started, open_game], table, 1, used_teams=[])
        assert r.pick.team_abbreviation == "BUF"

    def test_no_eligible_team_returns_no_pick_rather_than_raising(self):
        this_week = week_of(1, [("KC", "DEN", 0.9)])
        table = build_win_probability_table(this_week)
        r = sequence_dp.recommend(this_week, table, 1, used_teams=["KC", "DEN"])
        assert r.pick is None
        assert "No eligible teams" in r.reasoning


class TestDegradesHonestly:
    def test_one_week_loaded_still_picks_and_says_there_was_no_plan(self):
        # The failure entry_a_value documents for its own lookahead: given a
        # table that does not extend past this week, there is nothing to plan.
        # It must still pick, and must not describe the result as a sequence.
        this_week = week_of(1, [("KC", "DEN", 0.90), ("BUF", "NYJ", 0.70)])
        table = build_win_probability_table(this_week)

        r = sequence_dp.recommend(this_week, table, 1, used_teams=[])
        assert r.pick.team_abbreviation == "KC"
        assert len(r.path) == 1
        assert "no sequence was searched" in r.reasoning

    def test_the_reasoning_never_quotes_the_product_as_a_forecast(self):
        this_week = week_of(1, [("KC", "DEN", 0.90), ("BUF", "NYJ", 0.88)])
        later = week_of(2, [("PHI", "NYG", 0.88), ("SF", "SEA", 0.86)])
        table = build_win_probability_table(this_week + later)

        r = sequence_dp.recommend(this_week, table, 1, used_teams=[], lookahead_weeks=2)
        assert "ranking plans against each other" in r.reasoning
        assert "recomputed next week" in r.reasoning


class TestPruning:
    def test_every_week_keeps_a_candidate_even_under_a_tight_cap(self):
        # The additive top-up. With a cap of 2 and four weeks of distinct
        # teams, trimming would strip weeks bare; none may end up empty.
        weeks = []
        for w in range(1, 5):
            weeks += week_of(w, [(f"H{w}", f"A{w}", 0.9), (f"J{w}", f"B{w}", 0.8)])
        table = build_win_probability_table(weeks)
        this_week = [g for g in weeks if g.week == 1]

        r = sequence_dp.recommend(
            this_week, table, 1, used_teams=[], lookahead_weeks=4, max_candidate_teams=2,
        )
        assert r.pick is not None
        assert len(r.path) == 4, "a week was pruned out of existence"

    def test_the_search_is_deterministic_on_tied_probabilities(self):
        # Two teams on identical numbers is common once a price rounds. The
        # answer must not depend on dict ordering.
        this_week = week_of(1, [("AAA", "XXX", 0.80), ("BBB", "YYY", 0.80)])
        later = week_of(2, [("CCC", "ZZZ", 0.80)])
        table = build_win_probability_table(this_week + later)

        picks = {
            sequence_dp.recommend(
                this_week, table, 1, used_teams=[], lookahead_weeks=2
            ).pick.team_abbreviation
            for _ in range(10)
        }
        assert picks == {"AAA"}, f"tie-break is unstable: {picks}"
