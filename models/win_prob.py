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
# shallow: measured against 3,018 completed non-tie games with a posted line
# (nflverse, seasons 2015-2025), that rule scored a 10-point favourite at
# 62.1% where such teams actually won 85.4%, and a 14-point favourite at
# 66.4% against an actual 93.0%. An error of that size does not merely
# mislabel a pick, it inverts hold-versus-spend decisions -- a team the model
# thinks is a coin flip is one it will not wait for.
#
# The constants below are that same sample fitted by Newton-Raphson. Held
# out honestly -- fitted on 2015-2021, scored on 2022-2025 -- it beats the
# old rule on Brier score, 0.2098 against 0.2260, where 0.25 is a coin flip.
# By decile of predicted probability it sits within 3.1 points of observed.
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
    home_moneyline: Optional[float], away_moneyline: Optional[float], team_is_home: bool
) -> Optional[float]:
    """De-vigged win probability for one side, 0-100 scale.

    Needs *both* prices. One side alone carries the book's margin with no way
    to separate it out, and using it raw would read a 4-5 point overround as
    genuine confidence.
    """
    home_raw = implied_prob_from_moneyline(home_moneyline)
    away_raw = implied_prob_from_moneyline(away_moneyline)
    if home_raw is None or away_raw is None:
        return None

    total = home_raw + away_raw
    if total <= 0:
        return None

    share = (home_raw if team_is_home else away_raw) / total
    return max(MIN_WIN_PCT, min(MAX_WIN_PCT, share * PERCENT_SCALE))


def estimate_win_pct_from_spread(spread: Optional[float], team_is_home: bool) -> Optional[float]:
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
    home_pct = PERCENT_SCALE / (1.0 + math.exp(-z))
    estimate = home_pct if team_is_home else PERCENT_SCALE - home_pct
    return max(MIN_WIN_PCT, min(MAX_WIN_PCT, estimate))


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


def resolve_team_win_probability(game: Game, team_is_home: bool) -> TeamWeekWinProbability:
    """Build a normalized ``TeamWeekWinProbability`` for one side of one game."""
    team = game.home if team_is_home else game.away
    opponent = game.away if team_is_home else game.home

    win_pct: Optional[float] = None
    source = "unknown"

    prob = game.probability
    if prob is not None:
        raw = prob.home_win_pct if team_is_home else prob.away_win_pct
        if raw is not None:
            win_pct = raw * PERCENT_SCALE
            source = "api"

    if win_pct is None and game.odds is not None:
        market = win_pct_from_moneylines(
            game.odds.home_moneyline, game.odds.away_moneyline, team_is_home
        )
        if market is not None:
            win_pct = market
            source = "moneyline"

    if win_pct is None:
        spread = game.odds.spread if game.odds else None
        estimate = estimate_win_pct_from_spread(spread, team_is_home)
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
