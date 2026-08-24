"""The per-team market residual, and the scepticism applied to it.

The tests that matter here are not "does the arithmetic run". They are:

  * that a correction fitted on pure noise comes out at nothing, because that
    is the whole reason the shrinkage is estimated rather than chosen;
  * that a *real* bias, large enough and consistent enough, does survive --
    otherwise the previous point is satisfied by a function returning zero;
  * that the two shipped tables, JSON and JS, cannot drift apart.
"""
from __future__ import annotations

import json
import math
import random
import re
from pathlib import Path

import pytest

from data.teams import NFL_TEAMS
from models import team_bias
from models.market_curve import spread_line_from_home_share


ROOT = Path(__file__).resolve().parent.parent


def game(season, home, away, home_share, home_won, week=1):
    """One historical row priced at ``home_share`` with a decided result.

    Priced through the spread rather than a moneyline pair so the test does not
    also have to invert the de-vig -- ``market_home_share`` reads the same
    curve either way.
    """
    return {
        "season": season,
        "week": week,
        "game_type": "REG",
        "home_team": home,
        "away_team": away,
        "spread_line": spread_line_from_home_share(home_share),
        "home_score": 24 if home_won else 17,
        "away_score": 17 if home_won else 24,
    }


def coin_flip_rows(seasons=10, per_season=8, share=0.75, seed=11):
    """Games priced at ``share`` that actually land at ``share``. No bias at all."""
    rng = random.Random(seed)
    rows = []
    for i, season in enumerate(range(2017, 2017 + seasons)):
        for j in range(per_season):
            for home in NFL_TEAMS:
                away = NFL_TEAMS[(NFL_TEAMS.index(home) + 1 + j) % len(NFL_TEAMS)]
                rows.append(game(season, home, away, share, rng.random() < share, week=j + 1))
    return rows


# -- the market share a residual is measured against -------------------------

def test_market_share_prefers_the_moneyline_pair_over_the_spread():
    """The same two rungs, in the same order, that the shipped model uses.

    Fitting a residual against a *different* market model than the one it
    later corrects makes the "bias" absorb the disagreement between the two.
    """
    row = {
        "home_moneyline": -200, "away_moneyline": 170,
        # A spread that says something very different, so a fallback would show.
        "spread_line": 14.0,
    }
    share = team_bias.market_home_share(row)
    # -200/+170 de-vigged sits near 64%, nowhere near a 14-point favourite.
    assert 0.60 < share < 0.68

    del row["home_moneyline"]
    assert team_bias.market_home_share(row) > 0.85     # now the spread answers


def test_market_share_is_none_with_neither_a_price_nor_a_line():
    assert team_bias.market_home_share({"home_team": "KC"}) is None


def test_spread_line_sign_is_nflverses_not_espns():
    """Positive `spread_line` means the home side is favoured.

    ESPN's `spread` is the other way round, and copying that negation into this
    module would invert every residual in the table.
    """
    assert team_bias.market_home_share({"spread_line": 7.0}) > 0.5
    assert team_bias.market_home_share({"spread_line": -7.0}) < 0.5


# -- the finding: noise shrinks to nothing -----------------------------------

def test_a_calibrated_market_produces_essentially_no_adjustment():
    """The headline claim of the module, and the reason the constant changed.

    Every game here is priced correctly and resolved by a fair coin against
    that price, so the only variation between teams is sampling noise. There
    is nothing to find, and the two shrinkage rules disagree completely about
    whether they have found it.

    Run over eight independent draws rather than one, because the estimator of
    the between-team variance is itself noisy at 64 cells -- it lands on
    exactly zero on most draws and overshoots on the occasional one, and a
    single seed would be testing which of those was picked. Measured across
    these eight: empirical Bayes gives a mean adjustment of 0.00 to 0.81
    points and is *exactly* zero on five of them; `n / (n + 15)` gives 3.1 to
    4.0 points on every single one.

    That is the whole argument for the departure from the implementation this
    was ported from, so it is pinned here: restore the fixed constant and this
    fails rather than quietly shipping four-point corrections built on coin
    flips.
    """
    eb_means = []
    ported_means = []

    for seed in range(1, 9):
        rows = coin_flip_rows(seed=seed)
        table, cells, _tau2 = team_bias.build_bias_table(rows)
        assert len(cells) == 2 * len(NFL_TEAMS), "both venues fitted for every team"

        adjustments = [abs(v) for contexts in table.values() for v in contexts.values()]
        eb_means.append(sum(adjustments) / len(adjustments))

        # The same residuals, shrunk the way the ported version shrinks them.
        ported_means.append(sum(
            abs(c.residual) * 100.0 * (c.games / (c.games + 15.0)) for c in cells
        ) / len(cells))

        assert max(adjustments) < 3.0, (
            f"seed {seed}: pure noise produced a {max(adjustments):.2f} point adjustment"
        )

    eb = sum(eb_means) / len(eb_means)
    ported = sum(ported_means) / len(ported_means)
    assert ported > 5 * eb, (
        f"empirical Bayes attributes {eb:.2f} points of pure noise and n/(n+15) "
        f"attributes {ported:.2f}; if these are close the estimator has stopped working"
    )
    assert min(eb_means) == 0.0, (
        "on a sample with no real between-team variance the estimator should land on "
        "exactly zero at least sometimes; if it never does, tau^2 is not being floored"
    )


def test_a_real_bias_in_the_population_does_survive_the_shrinkage():
    """The other half: scepticism that rejects everything is not scepticism.

    Eight teams are genuinely under-priced at home, eight genuinely
    over-priced, and sixteen priced fairly -- so unlike the noise case there
    really is between-team variance for the estimator to find, and it should
    find it and sign it correctly.

    A *population* of biased teams rather than one outlier, because that is the
    hypothesis the estimator is built to test. Empirical Bayes pools across
    cells: a single biased team among thirty-one fair ones barely moves the
    estimated between-team variance and is therefore shrunk almost as hard as
    everybody else -- correct behaviour, and a real limitation worth stating.
    It is why this asserts on group means rather than on any one team.
    """
    rng = random.Random(5)
    under = set(NFL_TEAMS[:8])
    over = set(NFL_TEAMS[8:16])
    fair = NFL_TEAMS[16:]

    rows = []
    for season in range(2017, 2027):
        for j in range(8):
            for home in NFL_TEAMS:
                away = NFL_TEAMS[(NFL_TEAMS.index(home) + 1 + j) % len(NFL_TEAMS)]
                # Every game is *priced* at 70%. What differs is what happens.
                truth = 0.76 if home in under else 0.64 if home in over else 0.70
                rows.append(game(season, home, away, 0.70, rng.random() < truth, week=j + 1))

    table, _cells, tau2 = team_bias.build_bias_table(rows)
    assert math.sqrt(tau2) * 100 > 1.0, "a real between-team spread should be detected"

    mean = lambda teams: sum(table[t]["home"] for t in teams) / len(teams)
    assert mean(under) > 0.5, "under-priced teams should come back positive"
    assert mean(over) < -0.5, "over-priced teams should come back negative"
    assert abs(mean(fair)) < 0.5, "fairly priced teams should stay near zero"
    # Measured at 1.62 points of separation from an injected true bias of 12
    # (+6 / -6) -- so about an eighth survives, which is the shrinkage doing
    # its job on 80 games a cell rather than the signal being lost.
    assert mean(under) - mean(over) > 1.2, \
        "the two biased groups should separate, not merely order correctly"


def test_the_clamp_holds_whatever_the_residual():
    """The backstop, exercised directly rather than left to a future refit."""
    rows = []
    for season in range(2017, 2027):
        for j in range(20):
            rows.append(game(season, "KC", "DEN", 0.02, True, week=j + 1))
    table, _cells, _tau2 = team_bias.build_bias_table(rows, max_adjustment_pct=4.0)
    assert abs(table["KC"]["home"]) <= 4.0


# -- mechanics ---------------------------------------------------------------

def test_ties_are_dropped_rather_than_scored_as_half():
    """No win/loss label, matching how the spread logistic was fitted."""
    tied = dict(game(2026, "KC", "DEN", 0.7, True), home_score=20, away_score=20)
    assert team_bias.fit_cells([tied] * 40, min_games=1) == []


def test_unplayed_games_are_skipped():
    scheduled = dict(game(2026, "KC", "DEN", 0.7, True))
    scheduled["home_score"] = None
    scheduled["away_score"] = None
    assert team_bias.fit_cells([scheduled] * 40, min_games=1) == []


def test_recency_decay_is_anchored_to_one_shared_season():
    """A team absent from the newest season must not get a younger clock.

    Its old games would otherwise carry weight 1.0 while everybody else's
    carried 0.85^k, which quietly makes a stale team the most confident cell
    in the table.
    """
    rows = coin_flip_rows(seasons=4)
    latest = max(int(r["season"]) for r in rows)
    # Drop one team's newest season entirely.
    thinned = [r for r in rows
               if not (int(r["season"]) == latest and "KC" in (r["home_team"], r["away_team"]))]

    cells = {(_c.team, _c.venue): _c for _c in team_bias.fit_cells(thinned)}
    kc = cells[("KC", "home")]
    other = cells[("BUF", "home")]
    assert kc.weight < other.weight, \
        "a team missing the newest season should carry less weight, not more"


def test_between_variance_is_never_negative():
    """Zero is a real answer and has to come back as a number, not a raise."""
    cells = team_bias.fit_cells(coin_flip_rows(seasons=2, per_season=3))
    assert team_bias.estimate_between_variance(cells) >= 0.0
    assert team_bias.estimate_between_variance([]) == 0.0


def test_nflverse_abbreviations_are_translated_to_the_apps():
    """A silent mismatch here is a team that never gets an adjustment."""
    assert team_bias.canonical_team("LA") == "LAR"
    assert team_bias.canonical_team("WAS") == "WSH"
    assert team_bias.canonical_team("OAK") == "LV"
    assert team_bias.canonical_team("KC") == "KC"
    assert team_bias.canonical_team(None) is None


def test_bias_for_returns_zero_for_anything_it_does_not_know():
    table = {"KC": {"home": 1.5, "away": -0.5}}
    assert team_bias.bias_for(table, "KC", True) == 1.5
    assert team_bias.bias_for(table, "KC", False) == -0.5
    assert team_bias.bias_for(table, "NOPE", True) == 0.0
    assert team_bias.bias_for(table, None, True) == 0.0
    assert team_bias.bias_for(None, "KC", True) == 0.0
    assert team_bias.bias_for({"KC": {}}, "KC", True) == 0.0


def test_a_missing_or_broken_table_file_loads_as_empty(tmp_path):
    """A correction on top of a working model must never take the model down."""
    assert team_bias.load_bias_table(tmp_path / "nope.json") == {}
    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    assert team_bias.load_bias_table(broken) == {}


# -- the shipped artefacts ---------------------------------------------------

def test_the_shipped_table_covers_exactly_this_apps_teams():
    """Keyed by ESPN's abbreviations, because that is every join key in the app."""
    table = team_bias.load_bias_table()
    assert set(table) == set(NFL_TEAMS)
    for team, contexts in table.items():
        assert set(contexts) == {"home", "away"}, team


def test_the_shipped_table_is_inside_its_own_clamp():
    table = team_bias.load_bias_table()
    for team, contexts in table.items():
        for venue, points in contexts.items():
            assert abs(points) <= team_bias.DEFAULT_MAX_ADJUSTMENT_PCT, f"{team} {venue}"


def test_the_shipped_table_is_small_enough_to_be_the_empirical_bayes_one():
    """A guard against a refit that quietly restores a weak shrinkage.

    Not a claim that 0.5 is the right ceiling -- it is a tripwire. The current
    largest is 0.17, so anything past half a point means either the estimator
    changed or the sample did, and both deserve a human reading the report
    rather than a green suite.
    """
    largest = max(abs(v) for c in team_bias.load_bias_table().values() for v in c.values())
    assert largest < 0.5, (
        f"largest shipped adjustment is {largest:.3f} points; empirical Bayes on ten "
        "seasons produced 0.17. Re-read scripts/calibrate.py team-bias before raising this."
    )


def test_the_json_and_javascript_tables_are_the_same_numbers():
    """One fit, two files, written by one command -- and held together here.

    The browser reads a JS module because JSON import assertions are not
    portable enough to rely on. That is two artefacts of one measurement, and
    without this test a hand-edit to either would make the oracle and the port
    disagree about a team with nothing failing.
    """
    expected = json.loads((ROOT / "models/team_bias_table.json").read_text())["teams"]

    js = (ROOT / "deadpool/src/engine/team-bias-table.js").read_text()
    found = dict(
        (m.group(1), {"home": float(m.group(2)), "away": float(m.group(3))})
        for m in re.finditer(
            r"(\w+):\s*\{\s*home:\s*(-?[\d.]+),\s*away:\s*(-?[\d.]+)\s*\}", js
        )
    )

    assert set(found) == set(expected), "the two tables cover different teams"
    for team, contexts in expected.items():
        for venue in ("home", "away"):
            assert found[team][venue] == pytest.approx(contexts[venue], abs=1e-6), \
                f"{team} {venue}: JS says {found[team][venue]}, JSON says {contexts[venue]}"
