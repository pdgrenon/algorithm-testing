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
        KC?" -- barely, 96 against 95 -- and never asks the only question that
        matters, which is what covers *this* week if KC waits. Here BUF at 80%
        covers it well enough that holding KC is worth it::

            KC then CHI   0.95 + 0.95 x 0.55 = 1.472 weeks
            BUF then KC   0.80 + 0.80 x 0.96 = 1.568 weeks

        The heuristic takes KC now; the search takes BUF and banks KC for a
        week where nothing else is close.
        """
        this_week = week_of(1, [("KC", "DEN", 0.95), ("BUF", "NYJ", 0.80)])
        later = week_of(2, [("KC", "LV", 0.96), ("CHI", "GB", 0.55)])
        table = build_win_probability_table(this_week + later)

        from strategy import entry_a_value

        heuristic = entry_a_value.recommend(this_week, table, 1, used_teams=[])
        planned = sequence_dp.recommend(this_week, table, 1, used_teams=[], lookahead_weeks=2)

        assert heuristic.pick.team_abbreviation == "KC"
        assert planned.pick.team_abbreviation == "BUF"
        assert [p.team_abbreviation for p in planned.path] == ["BUF", "KC"]

    def test_front_loads_safety_where_the_product_would_not(self):
        """The order-sensitivity the old objective was blind to.

        Both plans spend the same two teams and have the same product, so
        maximising the product cannot tell them apart -- it used to pick the
        back-loaded one on a tie-break. Expected weeks can::

            KC then BUF   0.90 x 0.55 = 0.495 product, 1.395 weeks
            BUF then KC   0.55 x 0.90 = 0.495 product, 1.045 weeks

        Taking the safe team first is worth 0.35 of a week, because losing in
        week one forfeits everything downstream. This is the whole reason the
        objective moved, so it is pinned rather than left to the season.
        """
        this_week = week_of(1, [("KC", "DEN", 0.90), ("BUF", "NYJ", 0.55)])
        later = week_of(2, [("KC", "LV", 0.99), ("BUF", "MIA", 0.55)])
        table = build_win_probability_table(this_week + later)

        r = sequence_dp.recommend(this_week, table, 1, used_teams=[], lookahead_weeks=2)
        assert r.pick.team_abbreviation == "KC", "took the riskier team first"
        assert r.expected_weeks == pytest.approx(1.396, abs=0.01)

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
        assert "no plan was searched" in r.reasoning

    def test_the_reasoning_never_quotes_the_product_as_a_forecast(self):
        this_week = week_of(1, [("KC", "DEN", 0.90), ("BUF", "NYJ", 0.88)])
        later = week_of(2, [("PHI", "NYG", 0.88), ("SF", "SEA", 0.86)])
        table = build_win_probability_table(this_week + later)

        r = sequence_dp.recommend(this_week, table, 1, used_teams=[], lookahead_weeks=2)
        assert "ranking plans against each other" in r.reasoning
        assert "recomputed next week" in r.reasoning
        # And it must say what it is actually maximising, since "expected
        # length" and "chance of a clean run" are different claims and the
        # card shows both numbers.
        assert "splits among whoever gets deepest" in r.reasoning


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


class TestShadowPrice:
    """What spending a team costs, as a dual variable rather than a heuristic."""

    def test_interchangeable_teams_are_nearly_free(self):
        """The failure `compute_future_value` cannot see.

        BUF and PHI are the same shape all the way through: if one is spent
        the other fills its slot. Scored one at a time they look equally
        valuable to hold. Priced as a shadow -- what the plan actually loses --
        each is cheap, because the other covers for it.
        """
        w1 = week_of(1, [("KC", "DEN", 0.93), ("BUF", "NYJ", 0.90), ("PHI", "NYG", 0.90)])
        w2 = week_of(2, [("KC", "LV", 0.92), ("BUF", "MIA", 0.88), ("PHI", "DAL", 0.88)])
        w3 = week_of(3, [("KC", "CHI", 0.95), ("SEA", "ARI", 0.55)])
        table = build_win_probability_table(w1 + w2 + w3)

        prices = sequence_dp.shadow_prices_for(w1, table, 1, used_teams=[], lookahead_weeks=3)

        assert prices["BUF"] == pytest.approx(prices["PHI"], abs=1e-9), (
            "two teams that substitute for each other must price the same"
        )
        assert prices["KC"] > prices["BUF"], (
            "KC is the only cover for week 3 and must be the expensive one"
        )

    def test_nothing_is_ever_worth_less_than_free(self):
        # A negative shadow price would mean the objective is not monotone in
        # its inventory, which is a bug worth failing on rather than clamping.
        w1 = week_of(1, [("KC", "DEN", 0.9), ("BUF", "NYJ", 0.8), ("PHI", "NYG", 0.7)])
        w2 = week_of(2, [("KC", "LV", 0.9), ("BUF", "MIA", 0.6), ("SEA", "ARI", 0.8)])
        table = build_win_probability_table(w1 + w2)

        for team, price in sequence_dp.shadow_prices_for(
            w1, table, 1, used_teams=[], lookahead_weeks=2
        ).items():
            assert price >= -1e-12, f"{team} priced negative at {price}"

    def test_a_team_the_search_never_considers_costs_nothing(self):
        w1 = week_of(1, [("KC", "DEN", 0.95), ("BUF", "NYJ", 0.55)])
        table = build_win_probability_table(w1)
        prices = sequence_dp.shadow_prices_for(w1, table, 1, used_teams=[], lookahead_weeks=1)
        # DEN and NYJ are on the board as losing sides; spending them costs the
        # plan nothing, which is true of the plan and not of the season.
        assert prices.get("DEN", 0.0) == pytest.approx(0.0, abs=1e-12)

    def test_it_is_priced_in_the_units_the_strategy_optimises(self):
        # "Taking KC costs 0.3 weeks" only means something if the number is in
        # the same currency as the objective. Removing the whole inventory has
        # to give back the whole plan.
        w1 = week_of(1, [("KC", "DEN", 0.90), ("BUF", "NYJ", 0.85)])
        w2 = week_of(2, [("KC", "LV", 0.88), ("BUF", "MIA", 0.80)])
        table = build_win_probability_table(w1 + w2)

        plan = sequence_dp.recommend(w1, table, 1, used_teams=[], lookahead_weeks=2)
        prices = sequence_dp.shadow_prices_for(w1, table, 1, used_teams=[], lookahead_weeks=2)
        assert 0.0 < max(prices.values()) < plan.expected_weeks


class TestTheBeamKeepsWhatItHasToRank:
    """The dedup key, which is the reason the exact DP had to become a beam.

    Partial plans are collapsed on `(teams used, running product)`. The second
    half looks redundant -- a mask names a set of teams, and a product of the
    same teams is the same product -- and it is not, because a team's
    probability depends on the *week* it is spent in. Two plans can use the
    same two teams in opposite orders and carry different products.

    Collapsing the key to the mask alone passed the whole suite and all ten
    golden fixtures, so nothing anywhere held it. This board does: the plan
    with the higher accumulated value after two weeks is the one that loses
    over three, because the other carries forty times the product into the
    last week.
    """

    @staticmethod
    def _weekly():
        def pick(week, team, pct):
            return sequence_dp.WeekPick(
                week=week, team_abbreviation=team, opponent_abbreviation="X",
                is_home=True, win_pct=pct, win_pct_source="api",
                spread_detail=None, event_id=None,
            )
        return {
            # ARI is a bad pick this week and BUF is a good one...
            1: [pick(1, "BUF", 70.0), pick(1, "ARI", 30.0)],
            # ...and next week that reverses hard, so spending BUF now costs
            # the plan the 99% it would otherwise have carried forward.
            2: [pick(2, "BUF", 99.0), pick(2, "ARI", 1.0)],
            3: [pick(3, "CHI", 99.0)],
        }

    def test_the_plan_that_wins_is_the_one_that_is_behind_after_two_weeks(self):
        expected, product, path = sequence_dp.solve(self._weekly(), beam_width=50)
        assert [p.team_abbreviation for p in path] == ["ARI", "BUF", "CHI"]
        assert expected == pytest.approx(0.891, abs=1e-3)
        assert product == pytest.approx(0.294, abs=1e-3)

    def test_after_two_weeks_it_is_genuinely_behind(self):
        # Not a contrived tie: over the first two weeks alone the other
        # ordering scores higher, which is exactly why a key that keeps only
        # the best accumulated value per mask throws this plan away.
        weekly = {w: v for w, v in self._weekly().items() if w in (1, 2)}
        expected, _product, path = sequence_dp.solve(weekly, beam_width=50)
        assert [p.team_abbreviation for p in path] == ["BUF", "ARI"]
        assert expected == pytest.approx(0.707, abs=1e-3)

    def test_two_plans_over_the_same_teams_can_carry_different_products(self):
        # The premise, stated on its own: a mask does not determine a product,
        # because a team is not worth the same in every week.
        weekly = {w: v for w, v in self._weekly().items() if w in (1, 2)}
        _e, product, _path = sequence_dp.solve(weekly, beam_width=50)
        assert product == pytest.approx(0.70 * 0.01, abs=1e-6)
        # ...and the other ordering of the same two teams is worth far more.
        flipped = sequence_dp.solve(
            {1: [weekly[1][1]], 2: [weekly[2][0]]}, beam_width=50,
        )
        assert flipped[1] == pytest.approx(0.30 * 0.99, abs=1e-6)


class TestTheBeamKeepsTheBetterOfTwoInterchangeablePlans:
    """Dedup on `(teams used, running product)` keeps the best accumulated value.

    Two plans that spend the same teams end on the same mask and the same
    product, because multiplication does not care about order -- but the
    objective does. Expected weeks is the sum of the running products, so
    front-loading the safer team scores higher for the identical inventory.

    That is what makes the `>` in the dedup load-bearing, and it survived the
    suite: flipping it to `<` left the search keeping the worse of every
    colliding pair, still green.
    """

    def _order_only_board(self):
        """A board where the only decision left is which team to spend first."""
        wk1 = week_of(1, [("AAA", "ZZZ", 0.90), ("BBB", "YYY", 0.60)])
        wk2 = week_of(2, [("AAA", "XXX", 0.90), ("BBB", "WWW", 0.60)])
        table = build_win_probability_table(wk1 + wk2)
        # Every opponent struck off, so the universe is exactly {AAA, BBB} and
        # both plans -- AAA then BBB, BBB then AAA -- collide on both halves of
        # the dedup key.
        return wk1, table, ["ZZZ", "YYY", "XXX", "WWW"]

    def test_the_whole_plan_is_the_better_ordering(self):
        wk1, table, used = self._order_only_board()
        rec = sequence_dp.recommend(wk1, table, current_week=1, used_teams=used)

        spent = [step.team_abbreviation for step in rec.path]
        assert spent == ["AAA", "BBB"], "both plans spend both teams; only the order differs"
        assert sorted(rec.candidate_universe) == ["AAA", "BBB"], "nothing else was reachable"

        # The two orderings end on the same product, so survival is identical
        # and cannot be what separates them -- expected weeks is.
        a, b = (step.win_pct / 100.0 for step in rec.path)
        assert rec.survival_pct == pytest.approx(a * b * 100.0)
        assert rec.expected_weeks == pytest.approx(a + a * b)
        assert rec.expected_weeks > b + b * a, "the twin plan scores lower and must not be the one kept"

    def test_the_safer_team_is_spent_first(self):
        wk1, table, used = self._order_only_board()
        rec = sequence_dp.recommend(wk1, table, current_week=1, used_teams=used)
        assert rec.pick is not None
        assert rec.pick.team_abbreviation == "AAA", (
            "with the same two teams spent either way, taking the 90% team first is worth "
            "0.90 + 0.54 weeks against 0.60 + 0.54 -- the beam must keep that plan, not its twin"
        )
        assert "BBB" in rec.reasoning, "and the plan says the other team follows in week 2"
