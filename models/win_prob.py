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
from typing import Dict, List, Mapping, Optional, Tuple

from data.models import Game
from models import elo, team_bias
from models.elo import DEFAULT_MARKET_WEIGHT
from models.market_curve import (
    DEFAULT_DEVIG_METHOD,
    DEVIG_METHODS,
    SPREAD_LOGISTIC_INTERCEPT,
    SPREAD_LOGISTIC_SLOPE,
    devig,
    home_share_from_spread_line,
    implied_prob_from_moneyline,
    spread_line_from_home_share,
)

# ESPN's probabilities endpoint is fractional (0-1); everything in this
# module deals in whole percentage points (0-100) instead.
PERCENT_SCALE = 100.0

# The price-to-probability primitives -- the de-vig, the fitted spread curve
# and its inverse -- live in models/market_curve.py, with the calibration
# evidence for each. They are re-exported here so that
# `from models.win_prob import devig` or `SPREAD_LOGISTIC_SLOPE`, which scripts
# and tests do, keeps resolving, and so this module still reads as the one
# place a win probability comes from.
__all__ = [
    "SPREAD_LOGISTIC_INTERCEPT", "SPREAD_LOGISTIC_SLOPE",
    "home_share_from_spread_line", "spread_line_from_home_share",
    "PERCENT_SCALE", "MIN_WIN_PCT", "MAX_WIN_PCT",
    "DEVIG_METHODS", "DEFAULT_DEVIG_METHOD", "devig",
    "TIE_PROBABILITY", "DEFAULT_TIE_IS_LOSS", "advance_probability",
    "SHRINK_FREE_WEEKS", "DEFAULT_SHRINK_TAU", "SHRINK_PRIOR_PCT",
    "shrink_toward_prior",
    "TeamWeekWinProbability", "implied_prob_from_moneyline",
    "win_pct_from_moneylines", "estimate_win_pct_from_spread",
    "basis_phrase", "resolve_team_win_probability",
    "build_win_probability_table", "get_team_win_pct",
    "DEFAULT_MARKET_WEIGHT",
]

MIN_WIN_PCT = 1.0
MAX_WIN_PCT = 99.0

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

    # -- the model's own working, for a surface that wants to show it --------
    #
    # All five default to "nothing was applied", so every existing caller that
    # builds one of these positionally is unaffected, and a table built with no
    # Elo table and no bias table is bit-identical to one built before any of
    # this existed. That is not politeness -- it is what keeps the numbers in
    # engine/measured.js attached to the code that produced them.
    #
    # `market_win_pct` is the figure before the blend and the bias, so a screen
    # can show what moved and by how much rather than only the answer.
    market_win_pct: Optional[float] = None
    # Both spreads in the *home team's* convention -- positive means the home
    # side is favoured -- whichever team this row is about. See models/elo.py
    # for why that is fixed rather than relative to `team_abbreviation`.
    market_spread: Optional[float] = None
    elo_spread: Optional[float] = None
    divergence: Optional[float] = None
    # Points added by models/team_bias.py, signed. 0.0 when the correction is
    # off or the team is not in the table.
    team_bias_pct: float = 0.0


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
    home_share = home_share_from_spread_line(home_favored_by)
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


def _market_home_share(
    game: Game,
    devig_method: str = DEFAULT_DEVIG_METHOD,
) -> Optional[float]:
    """The game's market-implied **home** win share, conditional on no tie.

    The same three rungs as ``resolve_team_win_probability``, in the same
    order, but stopping one step earlier -- before the tie is folded in and
    before the 0-100 scaling. That is the scale a second model can be compared
    with, so it is what the Elo blend and the divergence are computed on.

    Always the home side's, never the requested team's. One game, one number:
    see models/elo.py on why the divergence has to be fixed to a side.
    """
    prob = game.probability
    if prob is not None and prob.home_win_pct is not None and prob.away_win_pct is not None:
        # ESPN's split is three-way and unconditional, so renormalising the two
        # win outcomes against each other is what removes the tie and puts this
        # on the same footing as a two-way price.
        total = prob.home_win_pct + prob.away_win_pct
        if total > 0:
            return prob.home_win_pct / total

    if game.odds is not None:
        home_raw = implied_prob_from_moneyline(game.odds.home_moneyline)
        away_raw = implied_prob_from_moneyline(game.odds.away_moneyline)
        if home_raw is not None and away_raw is not None and home_raw + away_raw > 0:
            return devig(home_raw, away_raw, devig_method)[0]

        if game.odds.spread is not None:
            # ESPN's spread is negative when the home side is favoured.
            return home_share_from_spread_line(-game.odds.spread)

    return None


def resolve_team_win_probability(
    game: Game,
    team_is_home: bool,
    tie_is_loss: bool = DEFAULT_TIE_IS_LOSS,
    devig_method: str = DEFAULT_DEVIG_METHOD,
    elo_table: Optional[Mapping[str, float]] = None,
    market_weight: float = DEFAULT_MARKET_WEIGHT,
    bias_table: Optional[Mapping[str, Mapping[str, float]]] = None,
) -> TeamWeekWinProbability:
    """Probability that one side of one game *advances*, however sourced.

    Every rung returns the same thing -- the chance this team is still
    alive after the game -- so callers never have to know which source
    answered or whether a tie was folded in.

    ── The two optional corrections ────────────────────────────────────────

    ``elo_table`` and ``bias_table`` are both off when omitted, and when both
    are omitted this returns exactly what it returned before either existed,
    bit for bit. Every default here is chosen to make that true, because the
    measured table in engine/measured.js was produced by the untouched path
    and a silent change to it would quietly detach those numbers from the
    code they describe.

    Both corrections are applied as an **additive delta to the finished
    percentage** rather than by re-deriving it. That is deliberate: the three
    rungs disagree about what scale they are natively on -- ESPN's figure is
    an unconditional three-way split, a moneyline pair is a two-way price, the
    spread fallback is a fitted curve -- and rebuilding the answer through a
    single scale would change the ESPN path's arithmetic, which is the one
    path with a published tie probability of its own.

    Both deltas are scaled by ``(1 - TIE_PROBABILITY)``, which is the exact
    derivative of "probability of advancing" with respect to "win share" under
    either tie rule (``advance = share*(1-t) + t`` and ``advance = share*(1-t)``
    have the same slope). So a correction fitted on the share scale lands on
    the advancing scale at the right size rather than 0.2% too large.
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

    market_win_pct = win_pct
    market_spread: Optional[float] = None
    elo_spread: Optional[float] = None
    divergence: Optional[float] = None
    team_bias_pct = 0.0

    market_home_share = _market_home_share(game, devig_method)
    if market_home_share is not None:
        elo_home_share = elo.home_win_share(
            elo_table, game.season_year, game.week,
            game.away.abbreviation, game.home.abbreviation,
        )
        comparison = elo.compare_models(market_home_share, elo_home_share, market_weight)
        market_spread = comparison.market_spread
        elo_spread = comparison.elo_spread
        divergence = comparison.divergence

        if win_pct is not None and comparison.blended:
            # The blend moves the *home* share; the away side moves by the
            # same amount in the opposite direction, which is what keeps a
            # game's two rows summing the way they did before.
            delta = comparison.blended_home_share - market_home_share
            if not team_is_home:
                delta = -delta
            win_pct = max(MIN_WIN_PCT, min(
                MAX_WIN_PCT, win_pct + delta * (1.0 - TIE_PROBABILITY) * PERCENT_SCALE,
            ))

    if bias_table is not None and win_pct is not None:
        team_bias_pct = team_bias.bias_for(bias_table, team.abbreviation, team_is_home)
        if team_bias_pct:
            win_pct = max(MIN_WIN_PCT, min(
                MAX_WIN_PCT, win_pct + team_bias_pct * (1.0 - TIE_PROBABILITY),
            ))

    return TeamWeekWinProbability(
        team_abbreviation=team.abbreviation,
        week=game.week,
        season_year=game.season_year,
        opponent_abbreviation=opponent.abbreviation,
        is_home=team_is_home,
        win_pct=win_pct,
        source=source,
        market_win_pct=market_win_pct,
        market_spread=market_spread,
        elo_spread=elo_spread,
        divergence=divergence,
        team_bias_pct=team_bias_pct,
    )


def build_win_probability_table(
    games: List[Game],
    elo_table: Optional[Mapping[str, float]] = None,
    market_weight: float = DEFAULT_MARKET_WEIGHT,
    bias_table: Optional[Mapping[str, Mapping[str, float]]] = None,
) -> Dict[Tuple[str, int], TeamWeekWinProbability]:
    """Assemble a ``{(team_abbreviation, week): TeamWeekWinProbability}`` table.

    ``games`` can be a single week's games or a season's worth collected
    across multiple calls to the ESPN client -- each game only needs a
    valid ``week`` and at least one team abbreviation to contribute a row.
    A bye week simply produces no entry for that team/week, which is the
    correct "clean" representation for callers like ``future_value``.

    ``elo_table``, ``market_weight`` and ``bias_table`` are passed through to
    ``resolve_team_win_probability`` unchanged; omitting all three is the
    behaviour every measured number in this project was produced under.
    """
    table: Dict[Tuple[str, int], TeamWeekWinProbability] = {}
    for game in games:
        if game.week is None:
            continue
        for team, is_home in ((game.home, True), (game.away, False)):
            if not team.abbreviation:
                continue
            entry = resolve_team_win_probability(
                game, is_home,
                elo_table=elo_table, market_weight=market_weight, bias_table=bias_table,
            )
            table[(team.abbreviation, game.week)] = entry
    return table


def get_team_win_pct(
    table: Dict[Tuple[str, int], TeamWeekWinProbability], team_abbreviation: str, week: int
) -> Optional[float]:
    """Convenience lookup; returns ``None`` for a bye week or missing data."""
    entry = table.get((team_abbreviation, week))
    return entry.win_pct if entry else None
