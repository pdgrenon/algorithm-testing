"""Market prices into probabilities: the curve and the de-vig, alone.

This is the layer underneath ``models/win_prob.py``: the two ways a posted
price becomes a probability -- de-vigging a moneyline pair, and the fitted
logistic on a spread -- plus the logistic's inverse.

It exists as its own file because three modules need exactly this set and
cannot all import each other. ``win_prob`` reads ``elo`` to blend in a second
model and reads ``team_bias`` to correct the result; both of those need to
score a price the same way ``win_prob`` would, so importing it back would be a
cycle. Everything here is arithmetic with no opinion about which source wins,
which is the natural place to cut.

``win_prob`` re-exports every name below, so an existing
``from models.win_prob import devig`` or ``SPREAD_LOGISTIC_SLOPE`` still
resolves and no caller had to change.

The one rule: **there is one copy of this curve.** A second one that drifted
by a hundredth would not fail a test. It would show up as a measured edge for
whichever strategy read the newer spelling -- which is precisely the artefact
that made scripts/field.py's scoring maths move into models/field_forecast.py
instead of being copied.
"""
from __future__ import annotations

import math
from typing import Optional, Tuple

# Spread -> win probability, as a logistic fitted to actual results.
#
# This was ``50 + spread * 1.2``, linear from a 50% baseline, and it was not
# close. Win probability is not linear in the spread and 1.2 is far too
# shallow. Measured against 3,018 completed non-tie games with a posted line
# (nflverse, seasons 2015-2025, regular season *and* postseason -- see the
# sample note below), on games laid at exactly ten points the favourite won
# 81.2% of 80, and at exactly fourteen 88.1% of 42. The old rule scores those
# two at 62.0% and 66.8%; the curve below scores them at 80.6% and 88.2%. An
# error of the old rule's size does not merely mislabel a pick, it inverts
# hold-versus-spend decisions -- a team the model thinks is a coin flip is one
# it will not wait for.
#
# The constants below are that same sample fitted by Newton-Raphson, and
# ``python3 scripts/calibrate.py spread`` re-derives them: the sample is all
# game types rather than the regular season alone, which is 3,018 games and
# reproduces these two values to four decimals, where the regular season alone
# is 2,885 and fits to -0.0453 / 0.1466 -- close enough to look like rounding
# and not the same model.
#
# Held out honestly -- refitted on 2015-2021, scored on 2022-2025 -- it beats
# the old rule on Brier score, 0.2098 against 0.2260, where 0.25 is a coin
# flip. Calibration is the part a Brier score cannot show, and it is not flat:
# by decile of predicted probability the worst band on that held-out set is
# 0.80-0.90, where the curve says 84.8% and the favourite won 91.8% of 73
# games. Nearly seven points, and *conservative* -- it under-states the
# favourite, so a survivor pick made on it is safer than the number claims,
# which is the direction to be wrong in. That table is printed by the same
# command; this comment said "within 3.1 points", which is one row of it
# rather than the worst.
#
# They are *written down* rather than fitted at run time on purpose: nothing
# in the suite may touch the network, so a model that calibrated itself on
# download would be untestable here and would make every run depend on a
# third-party file staying up. Re-derive them when the scoring environment
# has plainly moved, and say so in this comment when you do.
SPREAD_LOGISTIC_INTERCEPT = -0.0423
SPREAD_LOGISTIC_SLOPE = 0.1467


def home_share_from_spread_line(spread_line: float) -> float:
    """The fitted logistic: points the home side is favoured by -> its win share.

    ``spread_line`` is in the **home-favoured-by** convention -- positive means
    the home team is laying points. That is nflverse's ``spread_line`` sign and
    the sign the curve was fitted in; ESPN's ``spread`` is the opposite way
    round and is negated by its caller, not here.

    The share is conditional on no tie, because the sample it was fitted on
    excluded ties. Folding the tie back in is ``win_prob.advance_probability``,
    which is a separate step on purpose.
    """
    z = SPREAD_LOGISTIC_INTERCEPT + SPREAD_LOGISTIC_SLOPE * spread_line
    return 1.0 / (1.0 + math.exp(-z))


def spread_line_from_home_share(home_share: float) -> float:
    """Inverse of ``home_share_from_spread_line``: a win share back onto points.

    What puts a probability that never came from a spread -- an Elo model's,
    say -- onto the same scale as a posted line, so the two can be compared or
    averaged. Clamped away from 0 and 1 first, since the logit of either is
    infinite and a model that is certain is a model with a bug.
    """
    p = min(max(float(home_share), 1e-9), 1.0 - 1e-9)
    return (math.log(p / (1.0 - p)) - SPREAD_LOGISTIC_INTERCEPT) / SPREAD_LOGISTIC_SLOPE


# -- de-vigging ------------------------------------------------------------
#
# A two-way market's implied probabilities sum to more than 1. The excess is
# the book's margin, and how you take it back out is not a detail here.
#
# Multiplicative -- q_i / sum -- splits the margin in proportion, which loads
# most of it onto the favourite. Because the favourite-longshot bias means
# books shade longshot prices *up*, that is the wrong direction: it
# systematically understates the favourite. Survivor picks live between -300
# and -1000, exactly the lopsided region where the three methods diverge, and
# the error compounds across a multi-week product.
#
# Power -- solve for k with sum(q_i^k) = 1 -- loads more of the margin onto
# the longshot and always stays inside [0, 1]. Additive splits the overround
# evenly, and on a two-way market is equivalent to Shin.
#
# The default is `power` on that reasoning. The measured size of the
# disagreement is in scripts/calibrate.py, which is where a claim about it
# belongs -- do not assume a magnitude, compute it.
DEVIG_METHODS = ("power", "multiplicative", "additive")
DEFAULT_DEVIG_METHOD = "power"

# Bisection settings for the power method. A fixed iteration count rather than
# a tolerance loop, because this runs in two languages and must return the
# same bits in both: an early exit on |f| < eps can take a different number of
# steps under a last-ulp difference, and the parity fixtures would catch it as
# a mystery. 60 halvings of [0.2, 8] is far past double precision anyway.
_POWER_K_LO = 0.2
_POWER_K_HI = 8.0
_POWER_ITERATIONS = 60


def _bisect_power_k(home_raw: float, away_raw: float) -> float:
    """Solve sum(q_i^k) = 1 for k by bisection. See _POWER_ITERATIONS."""
    lo, hi = _POWER_K_LO, _POWER_K_HI
    for _ in range(_POWER_ITERATIONS):
        mid = (lo + hi) / 2.0
        if home_raw ** mid + away_raw ** mid > 1.0:
            lo = mid          # still over-round: needs a larger exponent
        else:
            hi = mid
    return (lo + hi) / 2.0


def devig(
    home_raw: float, away_raw: float, method: str = DEFAULT_DEVIG_METHOD
) -> Tuple[float, float]:
    """Two raw implied probabilities into a pair summing to 1.

    Returns ``(home, away)`` as fractions, both conditional on the game not
    being a tie -- a two-way price pushes on a tie, so that is what the market
    is quoting. Converting to a probability of *advancing* is
    ``advance_probability`` below, which is a separate step on purpose.
    """
    if method not in DEVIG_METHODS:
        raise ValueError(f"devig method must be one of {DEVIG_METHODS}, got {method!r}")

    total = home_raw + away_raw
    if total <= 0:
        raise ValueError("cannot de-vig a pair of non-positive prices")

    if method == "multiplicative":
        return home_raw / total, away_raw / total

    if method == "additive":
        # Split the overround evenly. Can push a heavy longshot below zero on
        # an extreme line, so it is clamped and renormalised rather than
        # returning a negative probability.
        excess = (total - 1.0) / 2.0
        home = max(0.0, home_raw - excess)
        away = max(0.0, away_raw - excess)
        adjusted = home + away
        if adjusted <= 0:
            return 0.5, 0.5
        return home / adjusted, away / adjusted

    k = _bisect_power_k(home_raw, away_raw)
    home = home_raw ** k
    away = away_raw ** k
    adjusted = home + away
    return home / adjusted, away / adjusted


def implied_prob_from_moneyline(moneyline: Optional[float]) -> Optional[float]:
    """One American moneyline as its raw, vig-included implied probability (0-1).

    A zero is not a price, so it is treated as absent rather than divided by.
    """
    if moneyline is None or moneyline == 0:
        return None
    if moneyline > 0:
        return 100.0 / (moneyline + 100.0)
    return -moneyline / (-moneyline + 100.0)
