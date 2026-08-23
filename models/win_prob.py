"""Clean, per-team, per-week win probabilities for the season.

``data/espn_client.py`` gives us, per game, an optional ``WinProbability``
(ESPN's own model, when they've published one) and an optional ``Odds``
carrying a spread and both moneylines. Not every game has a probability yet
-- ESPN sometimes doesn't publish one until close to kickoff -- so this
module normalizes every source it has into one consistent, per-team shape:

    win_pct   always on a 0-100 scale (ESPN's raw field is a 0-1 fraction)
    source    "api" | "moneyline" | "spread_estimate" | "unknown", so
              downstream code can tell how much to trust the number

and assembles them into a ``{(team_abbreviation, week): TeamWeekWinProbability}``
table spanning as many weeks of games as you feed it (a single week, or a
whole season's worth collected week by week).

── The order of preference, and why ────────────────────────────────────

``api`` first, because it is the figure the app names on screen. Then the
**moneyline pair**, de-vigged. Then the spread. Then nothing.

The moneyline step is new and it closes a hole: both moneylines were being
parsed, carried on the model and asserted in the tests, and no scoring path
had ever read either one -- so the sharpest number a book publishes was in
hand and discarded in favour of a rule of thumb. A moneyline is a price on
the outcome we actually care about; a spread is a price on the margin, which
then has to be converted into one. Prefer the former wherever both exist.

De-vigging is the whole of the conversion. The two raw implied probabilities
sum to more than 1 -- that excess is the book's margin -- so normalising the
pair to sum to 1 removes it. This is the standard treatment and it is
deliberately not clever: no shin, no power method, because those need a model
of how the vig is distributed between the sides and we have no evidence here
to prefer one.

Note that a moneyline is **not** an estimate in this project's sense. The
interface turns a figure amber when it came from a rule of thumb, and this
one came from a market. Only ``spread_estimate`` is amber.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from data.models import Game

# ESPN's probabilities endpoint is fractional (0-1); everything in this
# module deals in whole percentage points (0-100) instead.
PERCENT_SCALE = 100.0

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

MIN_WIN_PCT = 1.0
MAX_WIN_PCT = 99.0

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

# -- ties ------------------------------------------------------------------
#
# NFL ties are rare and this pool does not eliminate on one, so the whole term
# is small -- but it is free to get right and it points the opposite way from
# what most survivor writing assumes.
#
# The published normal-approximation formula is
# P(tie) = Phi((0.5-s)/sigma) - Phi((-0.5-s)/sigma), which returns about 3.0%
# at a pick-em line. The real rate is **0.215%** -- 15 ties in 6,967 regular
# season games, 1999-2025 (nflverse). The formula is out by roughly 14x
# because it measures "margin lands in (-0.5, 0.5)" under a continuous
# distribution, and an NFL game tied at the end of regulation plays overtime
# and usually resolves. Using it would have put a 3% thumb on every game.
#
# Measured by |spread| bucket the rate is flat inside its own noise (0.14% to
# 0.28% across five buckets, on 15 ties in total), so a constant is the honest
# model. There is not enough signal to justify a function of the spread.
TIE_PROBABILITY = 0.00215

# Whether a tie eliminates. Confirmed false for this pool, which is the
# *opposite* of the near-universal assumption in survivor writing -- so it
# is named here rather than left implicit, and every function that reads it
# takes it as an argument so a different pool needs no edit to this module.
DEFAULT_TIE_IS_LOSS = False


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


def advance_probability(
    win_share: float, tie_is_loss: bool, tie_probability: float = TIE_PROBABILITY
) -> float:
    """A conditional-on-no-tie win share into the probability of *advancing*.

    ``win_share`` is P(this team wins | the game is not a tie), which is what
    a de-vigged two-way market quotes and what the spread model is fitted on.

        P(win)     = win_share * (1 - P(tie))
        P(advance) = P(win)              if a tie eliminates you
                   = P(win) + P(tie)     if it does not

    Both branches exist because the answer flips with the pool's rules, and
    most survivor writing assumes the first. In *this* pool a tie is not a
    loss, so the second applies and P(advance) is 1 - P(opponent wins).
    """
    p_win = win_share * (1.0 - tie_probability)
    return p_win if tie_is_loss else p_win + tie_probability


# -- horizon shrinkage -----------------------------------------------------

# How a projection decays, measured rather than assumed.
#
# The first draft of this was a plain exp(-k/6), which shrinks from the very
# first week out -- an 85% projection became 79.6% one week ahead. The horizon
# report in scripts/calibrate.py says that is wrong. Scoring a rating fitted
# through week w against games k weeks later, over 2015-2024:
#
#     k = 1   log loss 0.6405        k = 5   0.6504
#     k = 2            0.6369        k = 6   0.6498
#     k = 3            0.6357        k = 7   0.6509
#     k = 4            0.6389        k = 8   0.6567
#
# Flat, and if anything slightly better, through four weeks out; degrading
# from five. So there is a free window before an estimate starts to rot, and
# shrinking inside it discards good information for nothing.
#
# Two honest caveats on that measurement. The proxy is a season-average margin
# rating, not a real projected line, because per-week historical projections
# are not available -- so the shape is trustworthy and the levels are not. And
# the whole effect is small: 0.016 of log loss across eight weeks against a
# base of 0.64, about 2.5%. This is a guard against over-committing to one
# projected blowout, not a large source of edge.
SHRINK_FREE_WEEKS = 4
DEFAULT_SHRINK_TAU = 6.0

# What a far-future probability is shrunk *toward*: an even game. Not the
# board average, which would be a different and moving target, and would make
# a week's shrinkage depend on which other games happen to be that week.
SHRINK_PRIOR_PCT = 50.0


def shrink_toward_prior(
    win_pct: Optional[float],
    weeks_ahead: int,
    tau: float = DEFAULT_SHRINK_TAU,
    prior_pct: float = SHRINK_PRIOR_PCT,
    free_weeks: int = SHRINK_FREE_WEEKS,
) -> Optional[float]:
    """Pull a projected win probability toward an even game with distance.

        lambda(k) = 1                            for k <= free_weeks
                  = exp(-(k - free_weeks) / tau)  beyond it
        shrunk    = prior + lambda * (estimate - prior)

    ``weeks_ahead`` is 0 for the current week, which is a posted line rather
    than a projection and is never touched. The free window in front of the
    decay is measured, not assumed -- see SHRINK_FREE_WEEKS above.

    Note what this deliberately does not do. It lowers confidence in any one
    far-future matchup; it does not lower the value of *having* many usable
    teams. Those pull opposite ways and only the first is handled here (see
    the spec's 2.4b): breadth-of-inventory value needs simulated rating drift,
    which belongs with the Monte Carlo engine and is not built yet.
    """
    if win_pct is None:
        return None
    if weeks_ahead <= free_weeks:
        return win_pct
    lam = math.exp(-(weeks_ahead - free_weeks) / tau)
    return prior_pct + lam * (win_pct - prior_pct)


@dataclass
class TeamWeekWinProbability:
    team_abbreviation: str
    week: Optional[int]
    season_year: Optional[int]
    opponent_abbreviation: Optional[str]
    is_home: bool
    win_pct: Optional[float]  # 0-100, or None if no basis at all
    source: str  # "api" | "moneyline" | "spread_estimate" | "unknown"


def implied_prob_from_moneyline(moneyline: Optional[float]) -> Optional[float]:
    """One American moneyline as its raw, vig-included implied probability (0-1).

    A zero is not a price, so it is treated as absent rather than divided by.
    """
    if moneyline is None or moneyline == 0:
        return None
    if moneyline > 0:
        return 100.0 / (moneyline + 100.0)
    return -moneyline / (-moneyline + 100.0)


def win_pct_from_moneylines(
    home_moneyline: Optional[float],
    away_moneyline: Optional[float],
    team_is_home: bool,
    method: str = DEFAULT_DEVIG_METHOD,
    tie_is_loss: bool = DEFAULT_TIE_IS_LOSS,
) -> Optional[float]:
    """De-vigged probability of *advancing* for one side, 0-100 scale.

    Needs *both* prices. One side alone carries the book's margin with no way
    to separate it out, and using it raw would read a 4-5 point overround as
    genuine confidence.

    Two steps, kept separate because they are different facts: ``devig`` turns
    the pair into shares conditional on no tie, and ``advance_probability``
    turns a share into the thing this pool actually scores.
    """
    home_raw = implied_prob_from_moneyline(home_moneyline)
    away_raw = implied_prob_from_moneyline(away_moneyline)
    if home_raw is None or away_raw is None:
        return None
    if home_raw + away_raw <= 0:
        return None

    home_share, away_share = devig(home_raw, away_raw, method)
    share = home_share if team_is_home else away_share
    advancing = advance_probability(share, tie_is_loss)
    return max(MIN_WIN_PCT, min(MAX_WIN_PCT, advancing * PERCENT_SCALE))


def estimate_win_pct_from_spread(
    spread: Optional[float],
    team_is_home: bool,
    tie_is_loss: bool = DEFAULT_TIE_IS_LOSS,
) -> Optional[float]:
    """Fallback win probability from the betting spread, 0-100 scale.

    ESPN's ``spread`` is signed relative to the home team (negative = home
    favored), so it is negated once here and everything downstream reads
    "how many points the home team is favoured by".

    The curve is solved for the **home** side and the away side is its
    complement, rather than solving the curve twice with a flipped sign. The
    intercept is a small home-field residual -- what is left over at a pick-em
    line -- and it must not change sign with the team being asked about. Doing
    it the other way also breaks the mirror property, where a home side at
    71.3% must leave the away side at exactly 28.7%.
    """
    if spread is None:
        return None
    home_favored_by = -spread
    z = SPREAD_LOGISTIC_INTERCEPT + SPREAD_LOGISTIC_SLOPE * home_favored_by
    home_share = 1.0 / (1.0 + math.exp(-z))
    # The logistic was fitted on completed *non-tie* games, so like a two-way
    # price it is already conditional on no tie and takes the same last step.
    share = home_share if team_is_home else 1.0 - home_share
    advancing = advance_probability(share, tie_is_loss)
    return max(MIN_WIN_PCT, min(MAX_WIN_PCT, advancing * PERCENT_SCALE))


def basis_phrase(source: str) -> str:
    """The parenthetical a surface adds after a percentage to name its source.

    Defined once because five surfaces draw it -- the terminal report, the HTML
    report and the three strategies' reasoning -- and the browser draws it from
    the ported twin. A sixth surface that forgot a new source would silently
    present a market price as ESPN's own model, which is exactly the confusion
    the ``source`` field exists to prevent. Same reason the counts are taken
    once rather than by whoever is rendering them.

    Empty for ``api``: silence has always meant "ESPN's published figure" on
    these surfaces, and there is no reason to start annotating the common case.
    """
    if source == "spread_estimate":
        return " (estimated from spread)"
    if source == "moneyline":
        return " (de-vigged moneyline)"
    return ""


def resolve_team_win_probability(
    game: Game,
    team_is_home: bool,
    tie_is_loss: bool = DEFAULT_TIE_IS_LOSS,
    devig_method: str = DEFAULT_DEVIG_METHOD,
) -> TeamWeekWinProbability:
    """Probability that one side of one game *advances*, however sourced.

    Every rung returns the same thing -- the chance this team is still
    alive after the game -- so callers never have to know which source
    answered or whether a tie was folded in.
    """
    team = game.home if team_is_home else game.away
    opponent = game.away if team_is_home else game.home

    win_pct: Optional[float] = None
    source = "unknown"

    prob = game.probability
    if prob is not None:
        raw = prob.home_win_pct if team_is_home else prob.away_win_pct
        if raw is not None:
            # ESPN publishes a three-way split -- home, away and tie -- so
            # unlike a two-way price this figure is already unconditional.
            # It needs the tie *added*, not multiplied out: a tie is an
            # outcome that already has its own share of the probability mass.
            advancing = raw
            if not tie_is_loss:
                advancing += prob.tie_pct or 0.0
            win_pct = max(MIN_WIN_PCT, min(MAX_WIN_PCT, advancing * PERCENT_SCALE))
            source = "api"

    if win_pct is None and game.odds is not None:
        market = win_pct_from_moneylines(
            game.odds.home_moneyline, game.odds.away_moneyline, team_is_home,
            devig_method, tie_is_loss,
        )
        if market is not None:
            win_pct = market
            source = "moneyline"

    if win_pct is None:
        spread = game.odds.spread if game.odds else None
        estimate = estimate_win_pct_from_spread(spread, team_is_home, tie_is_loss)
        if estimate is not None:
            win_pct = estimate
            source = "spread_estimate"

    return TeamWeekWinProbability(
        team_abbreviation=team.abbreviation,
        week=game.week,
        season_year=game.season_year,
        opponent_abbreviation=opponent.abbreviation,
        is_home=team_is_home,
        win_pct=win_pct,
        source=source,
    )


def build_win_probability_table(
    games: List[Game],
) -> Dict[Tuple[str, int], TeamWeekWinProbability]:
    """Assemble a ``{(team_abbreviation, week): TeamWeekWinProbability}`` table.

    ``games`` can be a single week's games or a season's worth collected
    across multiple calls to the ESPN client -- each game only needs a
    valid ``week`` and at least one team abbreviation to contribute a row.
    A bye week simply produces no entry for that team/week, which is the
    correct "clean" representation for callers like ``future_value``.
    """
    table: Dict[Tuple[str, int], TeamWeekWinProbability] = {}
    for game in games:
        if game.week is None:
            continue
        for team, is_home in ((game.home, True), (game.away, False)):
            if not team.abbreviation:
                continue
            entry = resolve_team_win_probability(game, is_home)
            table[(team.abbreviation, game.week)] = entry
    return table


def get_team_win_pct(
    table: Dict[Tuple[str, int], TeamWeekWinProbability], team_abbreviation: str, week: int
) -> Optional[float]:
    """Convenience lookup; returns ``None`` for a bye week or missing data."""
    entry = table.get((team_abbreviation, week))
    return entry.win_pct if entry else None
