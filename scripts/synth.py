"""Synthetic seasons, so that a policy comparison is a policy comparison.

Ten real seasons cannot separate these strategies, and `report_holdings` says
so: two of ten paid anything at all, and each strategy's ten-season mean rests
on a single year. That is not a fixable sample -- there are only ten of them,
and replaying the same ten from different starting weeks reuses the same
outcomes.

The spec's 7.1 prescribes the way out, and the argument is worth restating
because it is easy to mistake for cheating. **Because the generating
probabilities are known to be correct, a difference between two algorithms is
a pure policy difference rather than model error.** On real data a strategy
can win by having a better view of who will win the game, which is a different
question from how to spend an inventory over eighteen weeks. Here every
strategy is handed the true probability, so the only thing left to be better
at is the policy.

What this cannot do is tell you whether the engine's *probabilities* are any
good. That is what `calibrate.py` and the real backtest are for, and neither
is replaced.

── Fitted, not invented ────────────────────────────────────────────────────

A team gets a strength for the season and a game's price comes from the
difference::

    p(home) = logistic(strength_home - strength_away + HOME_EDGE + noise)

Four constants, and all four were fitted against 174 real week-slates from
2015-2024 rather than chosen. What was matched, and how close it lands:

                          synthetic     real (2015-2024)
    favourite win prob   0.653 / 0.103   0.668 / 0.103
    best team in a week  0.844 / 0.051   0.852 / 0.054
    the best team wins   84.8% of weeks  83.3% of weeks
    games per week       15.07 mean      15.07 mean

The favourite runs about a point and a half soft, which is the residual of
fitting a normal rating distribution to a league that has a fatter tail of
genuinely bad teams. The chalk-rate gap is inside one standard error of 174
weeks (0.028), so it is not evidence of anything.

Read the three-way split as the fifth fitted quantity: `TIE_PROBABILITY` is
the measured rate from 6,967 games, and a tie is a win for **both** sides,
which is this pool's confirmed rule and what `outcome_for` already does with
the real data.

── Shapes, deliberately identical to the real replay ───────────────────────

`season()` returns the same `(by_week, outcomes)` that `games_for_season` and
`outcome_for` return, built from the same `Game`/`Odds`/`WinProbability`
dataclasses. So every strategy in the harness runs against it unmodified, and
there is no second code path to drift. The price is set on `probability`
rather than a moneyline because that is the top rung of the source ladder --
the synthetic world is one where the book is exactly right, which is the whole
premise.
"""
from __future__ import annotations

import math
import random
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from data.models import Game, Team, WinProbability  # noqa: E402
from data.teams import NFL_TEAMS  # noqa: E402
from models.win_prob import TIE_PROBABILITY  # noqa: E402

# Fitted against 2015-2024; see the docstring for what was matched.
TEAM_STRENGTH_SD = 0.60
HOME_EDGE = 0.05
GAME_NOISE_SD = 0.10

# Teams do not stay as good as they started, and the first version of this
# assumed they did. Measured on 2015-2024 by fitting market-implied strengths
# over separate windows and watching how far a team moves as the gap widens:
#
#     windows            gap   move sd
#     (1-4) vs (5-8)       4     0.374
#     (1-4) vs (9-12)      8     0.468
#     (1-4) vs (14-17)    13     0.559
#
# It grows with the gap, so the movement is real -- but slower than a free
# random walk, which is the signature of a constant estimation error on top of
# genuine drift. Fitting var(gap) = 2*noise + drift*gap separates them: the
# windows are estimated to sd 0.165, and the genuine drift is **0.136 a week**.
#
# That is nearly as large as the between-team spread itself, which is the
# honest surprise here: over eighteen weeks a team moves about as far as the
# league is wide.
#
# The walk has to be **mean-reverting**, not free. A free walk widens the
# league every week, so by Week 18 the favourite is far stronger than any real
# board and the whole calibration below stops holding. phi is chosen to keep
# the stationary spread at TEAM_STRENGTH_SD while producing the measured
# per-week movement: var(step) = 2*sigma^2*(1 - phi).
STRENGTH_DRIFT_PHI = 0.9745

# The real distribution, as measured: 13 games 9% of weeks, 14 26%, 15 15%,
# 16 51%. Byes are why, and they matter here because a week with 13 games is a
# week with 26 teams to choose from rather than 32.
GAMES_PER_WEEK = ((13, 15), (14, 45), (15, 26), (16, 88))
WEEKS = 18


def _logistic(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _games_this_week(rng: random.Random) -> int:
    total = sum(weight for _, weight in GAMES_PER_WEEK)
    draw = rng.randrange(total)
    for count, weight in GAMES_PER_WEEK:
        draw -= weight
        if draw < 0:
            return count
    return GAMES_PER_WEEK[-1][0]


def season(
    seed: int,
    weeks: int = WEEKS,
    teams: Sequence[str] = None,
    strength_sd: float = TEAM_STRENGTH_SD,
    home_edge: float = HOME_EDGE,
    noise_sd: float = GAME_NOISE_SD,
    tie_probability: float = TIE_PROBABILITY,
    drift_phi: float = STRENGTH_DRIFT_PHI,
) -> Tuple[Dict[int, List[Game]], Dict[Tuple[int, str], str], Dict[str, float]]:
    """One synthetic season: the slate, what happened, and why.

    Returns ``(by_week, outcomes, strengths)`` in exactly the shapes
    ``games_for_season`` and ``outcome_for`` return, so the harness needs no
    second code path.

    The seed drives everything -- strengths, the schedule, and the results --
    so two strategies run on the same seed face an identical world. That is the
    common-random-numbers half of this; the field's own seed is separate,
    because varying opponents while holding the season fixed is a different
    question from varying the season.
    """
    names = list(NFL_TEAMS if teams is None else teams)
    rng = random.Random(seed)
    strengths = {name: rng.gauss(0.0, strength_sd) for name in names}
    # Innovation sized so the stationary spread stays `strength_sd`. At
    # drift_phi = 1 there is no drift and a team is as good in Week 18 as in
    # Week 1, which is what this generator assumed until it was measured.
    innovation = strength_sd * math.sqrt(max(0.0, 1.0 - drift_phi ** 2))

    by_week: Dict[int, List[Game]] = {}
    outcomes: Dict[Tuple[int, str], str] = {}

    for week in range(1, weeks + 1):
        if week > 1 and innovation > 0.0:
            for name in names:
                strengths[name] = strengths[name] * drift_phi + rng.gauss(0.0, innovation)

        playing = list(names)
        rng.shuffle(playing)
        count = min(_games_this_week(rng), len(playing) // 2)
        playing = playing[: count * 2]

        slate: List[Game] = []
        for i in range(0, len(playing), 2):
            home, away = playing[i], playing[i + 1]
            edge = strengths[home] - strengths[away] + home_edge
            if noise_sd:
                edge += rng.gauss(0.0, noise_sd)
            # The three-way split the top rung of the source ladder expects:
            # a tie is its own outcome, and the two win probabilities share
            # what is left of the mass.
            p_home = _logistic(edge) * (1.0 - tie_probability)
            p_away = 1.0 - tie_probability - p_home

            slate.append(Game(
                event_id=f"synth-{seed}-{week}-{i // 2}",
                competition_id=f"synth-{seed}-{week}-{i // 2}",
                week=week,
                season_year=seed,
                state="pre",
                home=Team(abbreviation=home, display_name=home),
                away=Team(abbreviation=away, display_name=away),
                probability=WinProbability(
                    # Fractions, despite the `_pct` in the names: the resolver
                    # multiplies by PERCENT_SCALE. Written as percentages
                    # first, which clamped every side to MAX_WIN_PCT and made
                    # both teams in every game 99% to advance -- a board on
                    # which no pick can be wrong, and one that no assertion
                    # about strategy would have looked odd on.
                    home_win_pct=p_home,
                    away_win_pct=p_away,
                    tie_pct=tie_probability,
                    is_pregame=True,
                ),
                odds=None,
            ))

            draw = rng.random()
            if draw < p_home:
                outcomes[(week, home)], outcomes[(week, away)] = "win", "loss"
            elif draw < p_home + p_away:
                outcomes[(week, home)], outcomes[(week, away)] = "loss", "win"
            else:
                # A tie is a win for both sides, which is this pool's rule and
                # what the real replay already does.
                outcomes[(week, home)] = outcomes[(week, away)] = "win"

        by_week[week] = slate

    # Note this is the *final* strength of each team, not the opening one --
    # they moved. Nothing reads it except the calibration report.
    return by_week, outcomes, strengths


def describe(seasons: int = 500, seed: int = 0) -> Dict[str, float]:
    """What the generator actually produces, for the test that holds the fit.

    Reported rather than asserted here: the assertions live in
    tests/test_synth.py, and this is what they read.
    """
    import statistics

    favourites: List[float] = []
    best_in_week: List[float] = []
    per_week: List[int] = []
    chalk_won = chalk_total = 0

    for s in range(seed, seed + seasons):
        by_week, outcomes, _ = season(s)
        for week, slate in by_week.items():
            per_week.append(len(slate))
            sides: List[Tuple[str, float]] = []
            for game in slate:
                home = game.probability.home_win_pct
                away = game.probability.away_win_pct
                favourites.append(max(home, away))
                sides.append((game.home.abbreviation, home))
                sides.append((game.away.abbreviation, away))
            if not sides:
                continue
            team, prob = max(sides, key=lambda s: s[1])
            best_in_week.append(prob)
            chalk_total += 1
            if outcomes.get((week, team)) == "win":
                chalk_won += 1

    return {
        "favourite_mean": statistics.mean(favourites),
        "favourite_sd": statistics.pstdev(favourites),
        "best_mean": statistics.mean(best_in_week),
        "best_sd": statistics.pstdev(best_in_week),
        "chalk_win_rate": chalk_won / chalk_total,
        "games_per_week": statistics.mean(per_week),
    }


if __name__ == "__main__":
    got = describe(seasons=int(sys.argv[1]) if len(sys.argv) > 1 else 500)
    real = {
        "favourite_mean": 0.668, "favourite_sd": 0.103,
        "best_mean": 0.852, "best_sd": 0.054,
        "chalk_win_rate": 0.833, "games_per_week": 15.07,
    }
    print(f"  {'quantity':<18} {'synthetic':>10} {'real 15-24':>11}")
    print("  " + "-" * 41)
    for key, value in got.items():
        print(f"  {key:<18} {value:10.3f} {real[key]:11.3f}")
