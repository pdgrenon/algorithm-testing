"""The pool: how the pot is settled, and how the simulated field behaves.

Several of these are the specific bugs the algorithm spec's own checklist
names as the ones that silently produce plausible-looking wrong answers.
They are written so a failure names the mistake rather than a number.
"""
import random

import pytest

from models.payout import (
    DEFAULT_POOL_SIZE,
    expected_perfect_entries,
    fair_share,
    pot_share,
    settle,
    value_of,
)
from scripts import field as fm


class TestDeepestSplits:
    def test_the_pot_is_never_left_unclaimed(self):
        """The whole reason this rule exists.

        The clean "1/n if you went 18-0" function returns zero for everybody in
        the modal season, which wastes every simulated path that reaches it.
        This one always pays somebody.
        """
        depths = {"a": 7, "b": 4, "c": 2}
        assert sum(p.share for p in settle(depths).values()) == pytest.approx(1.0)

    def test_only_the_deepest_are_paid_and_they_split_evenly(self):
        depths = {"a": 11, "b": 11, "c": 10, "d": 3}
        out = settle(depths)
        assert out["a"].share == pytest.approx(0.5)
        assert out["b"].share == pytest.approx(0.5)
        assert out["c"].share == 0.0, "one week short is worth nothing"
        assert out["d"].share == 0.0

    def test_a_perfect_season_is_the_same_rule_not_a_special_case(self):
        depths = {"a": 18, "b": 18, "c": 17}
        out = settle(depths)
        assert out["a"].share == pytest.approx(0.5)
        assert out["a"].went_the_distance is True
        assert out["c"].share == 0.0

    def test_nobody_perfect_is_the_expected_ending_at_this_field_size(self):
        # 0.87 expected unbeaten entries out of 250. Below one, so the deepest
        # -splits branch is the normal ending rather than an edge case, and
        # this is the number that says so.
        assert expected_perfect_entries(DEFAULT_POOL_SIZE) < 1.0

    def test_a_fair_entry_is_worth_exactly_the_buy_in(self):
        assert value_of(fair_share()) == pytest.approx(10.0)


class TestYourEntriesAreInTheDenominator:
    """The spec's checklist item 3, and it can be got wrong two ways."""

    def test_holding_two_entries_counts_as_two(self):
        # Three entries tie at the deepest week and two of them are yours, so
        # you take two thirds -- not one third, and not one half.
        depths = {"mine-a": 9, "mine-b": 9, "theirs": 9, "other": 4}
        assert pot_share(depths, ["mine-a", "mine-b"]) == pytest.approx(2 / 3)

    def test_a_dead_entry_of_yours_adds_nothing(self):
        depths = {"mine-a": 9, "mine-b": 3, "theirs": 9}
        assert pot_share(depths, ["mine-a", "mine-b"]) == pytest.approx(0.5)

    def test_the_field_includes_you(self):
        pool = fm.build_field(250, ["mine-a", "mine-b"])
        assert len(pool) == 250, "your entries take two of the 250 seats"
        assert "mine-a" in pool and "mine-b" in pool


class TestTheFieldBehaves:
    def test_an_opponent_never_picks_the_same_team_twice(self):
        # Checklist item 8: inventories not carried forward gives late-season
        # fields unrealistic availability, and it is invisible in aggregate.
        rng = random.Random(1)
        opponent = fm.Opponent(entry_id="o")
        board = [("KC", 90.0), ("BUF", 85.0), ("PHI", 80.0)]
        outcomes = {(w, t): "win" for w in range(1, 4) for t, _ in board}
        for week in range(1, 4):
            fm.advance(opponent, board, outcomes, week, rng)
        assert len(opponent.used) == 3, f"reused a team: {opponent.used}"

    def test_running_out_of_teams_ends_a_run_rather_than_pausing_it(self):
        rng = random.Random(1)
        opponent = fm.Opponent(entry_id="o", used={"KC"})
        outcomes = {(1, "KC"): "win"}
        fm.advance(opponent, [("KC", 90.0)], outcomes, 1, rng)
        assert opponent.alive is False

    def test_concentration_is_what_tau_controls(self):
        # Checklist item 5 in spirit: the weights are a distribution over what
        # is *available*, so they must renormalise rather than leak mass.
        board = [("KC", 90.0), ("BUF", 80.0), ("PHI", 70.0), ("NYJ", 55.0)]
        sharp = fm.pick_weights(board, fm.SHARP_TAU)
        casual = fm.pick_weights(board, fm.CASUAL_TAU)
        assert sharp[0] / sum(sharp) > casual[0] / sum(casual), (
            "a sharper field must concentrate harder on the best team"
        )
        for weights in (sharp, casual):
            assert sum(weights) > 0
            assert all(w >= 0 for w in weights)

    def test_slip_is_off_by_default_because_exhaustion_already_explains_the_rate(self):
        """Measured: the field reaches the historical survival rate unaided.

        A field picking favourites survives at 83% in any one week, and the
        historical public figure is 73%. The gap closes on its own once teams
        are consumed -- an entry cannot keep taking the chalk it spent in
        September. Turning slip up now pushes the field *below* the historical
        rate rather than toward it.
        """
        assert fm.DEFAULT_SLIP == 0.0
        assert fm.CHALK_WEEKLY_SURVIVAL > fm.TARGET_WEEKLY_SURVIVAL
        assert abs(fm.MODELLED_WEEKLY_SURVIVAL - fm.TARGET_WEEKLY_SURVIVAL) < 0.02

    def test_a_slipped_entry_still_picks_something_legal(self):
        rng = random.Random(4)
        board = [("KC", 90.0), ("BUF", 80.0)]
        for _ in range(50):
            assert fm.choose(board, rng, fm.CASUAL_TAU, slip=1.0) in {"KC", "BUF"}


class TestScheduleShape:
    def test_every_team_plays_seventeen_of_eighteen_weeks(self):
        """Checklist item 7, and item 2 by implication.

        An off-by-one around byes is invisible: the board still renders, the
        picks still look sensible, and one team is quietly pickable on a week
        it is not playing. Checked against real schedule data rather than a
        fixture, because this is a fact about the NFL and not about the app.
        """
        import sys
        from pathlib import Path

        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from scripts.backtest import CACHE, games_for_season, load_rows

        if not CACHE.exists():
            pytest.skip("nflverse results not cached; run scripts/backtest.py once")

        by_week = games_for_season(load_rows(), 2023)
        weeks_for: dict[str, int] = {}
        for week, games in by_week.items():
            for game in games:
                for side in (game.home, game.away):
                    weeks_for[side.abbreviation] = weeks_for.get(side.abbreviation, 0) + 1

        assert len(weeks_for) == 32, f"expected 32 teams, got {len(weeks_for)}"
        assert set(weeks_for.values()) == {17}, (
            f"every team plays exactly 17 of 18 weeks; got {sorted(set(weeks_for.values()))}"
        )


class TestFittingTauToARealSheet:
    """The prior every conclusion in the harness rests on, made replaceable."""

    @staticmethod
    def _board():
        from scripts import synth
        from models.win_prob import resolve_team_win_probability
        by_week, _, _ = synth.season(3)
        out = []
        for game in by_week[1]:
            for home in (True, False):
                r = resolve_team_win_probability(game, home)
                if r.win_pct is not None:
                    out.append((r.team_abbreviation, r.win_pct))
        out.sort(key=lambda c: (-c[1], c[0]))
        return out

    @pytest.mark.parametrize("true_tau", [0.15, 0.25, 0.35, 0.50, 0.70])
    def test_it_recovers_the_tau_that_produced_the_picks(self, true_tau):
        board = self._board()
        weights = fm.pick_weights(board, true_tau)
        total = sum(weights)
        observed = {team: w / total for (team, _), w in zip(board, weights)}
        assert fm.fit_tau(observed, board) == pytest.approx(true_tau, abs=0.01)

    def test_it_survives_a_field_that_is_not_a_clean_multinomial(self):
        """Which the real one will not be.

        250 people are not draws from a logit. Some take their own team, some
        copy a friend, some pick last. Perturb every share and round to whole
        entries -- what a sheet actually contains -- and the fit should still
        land near the truth rather than anywhere.
        """
        import random

        board = self._board()
        rng = random.Random(11)
        weights = fm.pick_weights(board, 0.35)
        total = sum(weights)
        counts = []
        for (_team, _), w in zip(board, weights):
            share = (w / total) * rng.uniform(0.6, 1.4)      # noisy
            counts.append(max(0, round(share * 250)))         # and whole entries
        pool = sum(counts) or 1
        observed = {team: n / pool for (team, _), n in zip(board, counts) if n}
        assert fm.fit_tau(observed, board) == pytest.approx(0.35, abs=0.10)

    def test_nothing_to_fit_is_none_rather_than_a_number(self):
        # A week nobody has played yet must not come back as a confident tau.
        assert fm.fit_tau({}, self._board()) is None
        assert fm.fit_tau({"KC": 1.0}, []) is None

    def test_a_more_concentrated_field_fits_a_lower_tau(self):
        # The direction, stated once so nobody has to re-derive it: low tau is
        # a field piling onto the chalk, high tau is one spreading out.
        board = self._board()
        top = board[0][0]
        crowded = fm.fit_tau({top: 0.90, board[1][0]: 0.10}, board)
        spread = fm.fit_tau({t: 1 / 6 for t, _ in board[:6]}, board)
        assert crowded < spread


class TestTerminalField:
    """How many opponents you expect to be splitting with at the end.

    Untested until now, and both directions of an off-by-one in the exponent
    survived the whole suite. It is the number a pot-share model divides by,
    and models/joint_pot_share.py records that getting it wrong once reversed
    the answer outright -- so an exponent nobody checks is the wrong kind of
    quiet.
    """

    def test_the_projection_is_survival_to_the_final_week(self):
        # The docstring's own worked example: 249 opponents in Week 1 project
        # forward seventeen weeks, not sixteen and not eighteen.
        assert fm.terminal_field(249, week=1, final_week=18, weekly_survival=0.73) == max(
            1, round(249 * 0.73 ** 17)
        )

    def test_each_week_that_passes_is_one_less_week_of_attrition(self):
        got = [fm.terminal_field(249, week=w, final_week=18, weekly_survival=0.73) for w in range(1, 19)]
        assert got == [max(1, round(249 * 0.73 ** (18 - w))) for w in range(1, 19)]
        assert got == sorted(got), "the projected field only grows as the horizon shortens"

    def test_the_final_week_projects_the_field_as_it_stands(self):
        assert fm.terminal_field(40, week=18, final_week=18) == 40, "no weeks left, so no attrition"
        assert fm.terminal_field(40, week=25, final_week=18) == 40, "past the end is still no attrition"

    def test_never_zero_opponents(self):
        """Zero would make the pot yours whatever you pick.

        Every candidate then scores identically, which is never true and is a
        silent way for a pot-share strategy to stop discriminating at all.
        """
        assert fm.terminal_field(1, week=1, final_week=18, weekly_survival=0.5) == 1
        assert fm.terminal_field(0, week=1, final_week=18) == 1


class TestPopularityFromInventories:
    """The number the whole pot-share half rests on, and nothing asserted it.

    It appears in the harness tests only as a helper feeding something else,
    so making it return `{}` for every input -- by never advancing its own
    denominator -- left the suite green. A pot-share strategy handed an empty
    popularity map is a strategy with no opponents at all.
    """

    BOARD = [("AAA", 90.0), ("BBB", 80.0), ("CCC", 70.0), ("DDD", 60.0)]

    def test_a_full_inventory_field_is_one_multinomial_over_the_board(self):
        shares = fm.popularity_from_inventories([set(), set(), set()], self.BOARD)
        assert set(shares) == {"AAA", "BBB", "CCC", "DDD"}
        assert sum(shares.values()) == pytest.approx(1.0)
        # Everyone faces the same choice, so it is the weight vector itself.
        weights = fm.pick_weights(self.BOARD)
        total = sum(weights)
        for (team, _), w in zip(self.BOARD, weights):
            assert shares[team] == pytest.approx(w / total)

    def test_the_chalk_is_the_most_popular(self):
        shares = fm.popularity_from_inventories([set()] * 5, self.BOARD)
        assert max(shares, key=shares.get) == "AAA"

    def test_an_entry_that_spent_the_chalk_is_somewhere_else(self):
        """Averaged over each opponent's own inventory, which is the point.

        Computed once over the whole board it would say the chalk holds the
        same share every week, when the entries that already spent it are by
        definition not on it.
        """
        half_spent = fm.popularity_from_inventories([set(), {"AAA"}], self.BOARD)
        all_free = fm.popularity_from_inventories([set(), set()], self.BOARD)
        assert half_spent["AAA"] < all_free["AAA"]
        assert half_spent["BBB"] > all_free["BBB"], "the field it displaced has to land somewhere"
        assert sum(half_spent.values()) == pytest.approx(1.0)

    def test_an_entry_with_nothing_left_is_not_in_the_denominator(self):
        spent_out = {t for t, _ in self.BOARD}
        with_dead = fm.popularity_from_inventories([set(), set(), spent_out], self.BOARD)
        without = fm.popularity_from_inventories([set(), set()], self.BOARD)
        assert with_dead == pytest.approx(without), (
            "an entry that cannot pick anything cannot be a share of who picks what"
        )

    def test_no_inventories_at_all_is_empty_rather_than_a_division(self):
        assert fm.popularity_from_inventories([], self.BOARD) == {}
        assert fm.popularity_from_inventories([set()], []) == {}


class TestTheFieldsRandomStream:
    """The simulated field is the measurement, so its draws are part of it.

    Every published rating in deadpool/src/engine/measured.js came out of this
    stream at a fixed seed. A change that consumes a different number of draws
    produces different fields for the same seed and silently invalidates all of
    them, while every distributional assertion still passes -- which is exactly
    what taking the slip draw at `slip = 0` does.
    """

    BOARD = [("AAA", 90.0), ("BBB", 80.0), ("CCC", 70.0), ("DDD", 60.0)]

    def test_at_zero_slip_no_draw_is_spent_on_the_slip(self):
        # Two calls off one generator. If `choose` consumed a slip draw it did
        # not use, the second answer would come from a different position in
        # the stream.
        rng = random.Random(11)
        got = [fm.choose(self.BOARD, rng, slip=0.0) for _ in range(4)]

        rng = random.Random(11)
        expected = []
        for _ in range(4):
            weights = fm.pick_weights(self.BOARD)
            total = sum(weights)
            draw = rng.random() * total
            for (team, _), w in zip(self.BOARD, weights):
                draw -= w
                if draw <= 0:
                    expected.append(team)
                    break
        assert got == expected, "one draw per pick, and it is the popularity draw"

    def test_the_same_seed_gives_the_same_field(self):
        def run(seed):
            rng = random.Random(seed)
            return [fm.choose(self.BOARD, rng, slip=0.0) for _ in range(20)]
        assert run(7) == run(7)
        assert run(7) != run(8), "and a different seed is a different field"


class TestNamingTheFieldExplicitly:
    """`entry_ids` is the denominator, and ignoring it inflates your share.

    Without it `settle` reads the field off the keys of `last_week_survived`,
    which is right only when every entry has a recorded depth. An entry that
    never picked has none -- and it is still in the pool, still staked, still
    part of what the pot is divided by. Dropping the parameter left the whole
    suite green while quietly shrinking the field.
    """

    def test_an_entry_with_no_recorded_depth_is_still_in_the_field(self):
        depths = {"me": 6, "them": 6}
        field = ["me", "them", "never-picked"]

        settled = settle(depths, entry_ids=field)
        assert set(settled) == set(field), "everybody named gets a payout, even a zero one"
        assert settled["never-picked"].share == 0.0
        assert settled["me"].winners == 2
        assert settled["me"].share == pytest.approx(0.5)

    def test_the_named_field_is_what_the_pot_is_split_over(self):
        # Everybody out in the same week: the whole field ties for deepest, so
        # naming one more entry is one more way the pot divides.
        depths = {"a": 0, "b": 0}
        two = settle(depths, entry_ids=["a", "b"])
        three = settle(depths, entry_ids=["a", "b", "c"])
        assert two["a"].share == pytest.approx(1 / 2)
        assert three["a"].share == pytest.approx(1 / 3)

    def test_pot_share_reads_your_own_entries_out_of_the_named_field(self):
        depths = {"me0": 9, "me1": 9, "opp": 4}
        mine = pot_share(depths, ["me0", "me1"], entry_ids=["me0", "me1", "opp", "silent"])
        assert mine == pytest.approx(1.0), "both of yours are deepest, so the pot is yours"

    def test_without_it_the_field_is_whoever_has_a_depth(self):
        depths = {"a": 3, "b": 3}
        assert set(settle(depths)) == {"a", "b"}
