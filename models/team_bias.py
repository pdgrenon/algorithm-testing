"""Per-team, per-venue correction for where the market has been wrong before.

The market is the best single estimate this project has, and everything in
``models/win_prob.py`` is built on that. This module asks the one follow-up
question worth asking of any estimator: **has it been wrong in the same
direction, for the same team, in the same place, for long enough that the
pattern is not noise?**

For every completed game a team played in one venue context, take

    residual = actual_outcome - market_implied_share

and average it. A team the market has systematically under-priced at home
comes out positive; one it has over-priced comes out negative.

The answer, measured here on ten seasons, is **almost entirely noise**, and
the shape of this module is the consequence of taking that seriously.

── What the measurement actually said ──────────────────────────────────────

Across 64 team/venue cells, 2,383 regular season games 2017-2026, median 74
games each -- the run that produced the shipped table, reproducible with
``python3 scripts/calibrate.py team-bias``:

    spread of the observed cell residuals      sd 5.76 points
    spread expected from sampling alone        sd 5.73 points
    implied true between-team spread           sd 0.58 points

Almost all of the variation between teams is the variation you would get by
flipping 74 weighted coins per cell against a perfectly calibrated market.
What is left over -- the part that could be real -- is about six tenths of a
point, and that is an upper bound rather than a finding, because it is the
residue of subtracting two nearly equal numbers. Read it as "no larger than
this", not as "this".

This is what a liquid market is supposed to look like. A book reliably three
points light on one team at home would be an exploitable edge sitting in
public view, and the null hypothesis deserved to win.

── Which is why the shrinkage is estimated, not chosen ─────────────────────

An estimate this noisy has to be shrunk toward zero by how much of it is
noise, and that ratio is a measurable property of the sample rather than a
taste. The estimator is textbook empirical Bayes:

    shrink = tau^2 / (tau^2 + s^2)

where ``s^2`` is the cell's own sampling variance and ``tau^2`` is the
between-team variance estimated across all cells. On this sample it comes out
at **0.010** -- a cell keeps one percent of what it appears to show. The
largest surviving adjustment in the shipped table is SEA away, **+0.17
points**; the mean is 0.05.

This is the one place this module departs from the implementation it was
ported from (``ssgrenon/survivor-picker``, commit 4e58d42), and the departure
is not stylistic. That version shrinks by a hardcoded ``n / (n + 15)``. At 74
games per cell that factor is **0.83** -- 83x more than the data supports. Run
with those constants on this sample, 26 of the cells hit the +/-4 point clamp
and the mean adjustment is 2.7 points: it would move a survivor pick by up to
four points of win probability on what the variance decomposition says is a
coin flip. That is not a difference in tuning, it is the difference between a
correction and a random number generator with a team's name on it.

The clamp survives anyway, as a backstop rather than a working part. Under
empirical Bayes nothing on this sample gets within an order of magnitude of
it -- which is itself the reason to keep it, since a future refit on a thinner
or stranger sample is exactly the case nobody will be watching.

── It is off by default ────────────────────────────────────────────────────

**Nothing here has measured whether this helps a pick.** The variance
decomposition above says how much signal is present, which is a different and
weaker claim than "correcting by it survives better". And given that the
largest surviving adjustment is 0.17 points on a board whose candidates spread
over twenty, the honest prediction is that it changes nothing measurable --
this is built as a mechanism that can be turned on and measured, not as an
edge anybody should expect.

So it is built, wired, and switched off, and the number to beat is the one
already in ``engine/measured.js``. Until somebody beats it, "off" is the
measured configuration and "on" is a guess.

**How to measure it, since this does not yet plug into the harness.**
``scripts/backtest.py`` threads its cross-cutting options (``--field-tau``
and the rest) explicitly through every scoring signature *and* through the
multiprocessing work tuples, and this correction would have to travel the
same route -- it is not a flag that can be bolted on at the top. The run that
would settle it is the real-seasons path rather than ``--synthetic``: the
synthetic world's market is unbiased by construction, so replaying this
against it can only measure the cost of adding noise, not the benefit of
removing a bias that is not there. Ten real seasons against ten real seasons,
paired, with and without.

── Fitted offline, written down ────────────────────────────────────────────

The table lives in ``models/team_bias_table.json`` and is regenerated by
``python3 scripts/calibrate.py team-bias --write``. It is not computed at run
time, for the same reason ``SPREAD_LOGISTIC_INTERCEPT`` is not: nothing in the
suite may touch the network, and a model that refitted itself on download
would be untestable here and would make every run depend on a third-party file
staying up. The browser reads the same JSON through ``engine/team-bias.js``,
so the two languages cannot drift onto different numbers.

── The one scale mismatch, stated rather than hidden ───────────────────────

Residuals are fitted on the **no-tie share** -- the quantity a two-way price
actually quotes -- and tied games are dropped, matching how the spread
logistic in ``win_prob`` was fitted. The adjustment is then applied to a
probability of *advancing*, which folds the tie back in. Those two scales
differ by ``TIE_PROBABILITY`` = 0.215%, so an adjustment carries at most 0.2%
of relative error from the mismatch -- three orders of magnitude below the
adjustments themselves. Not worth a second code path; written here so nobody
has to rediscover it.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from models.market_curve import (
    DEFAULT_DEVIG_METHOD,
    devig,
    home_share_from_spread_line,
    implied_prob_from_moneyline,
)

# How much a season of distance discounts a residual. Rosters, coaches and
# stadiums turn over; a 2015 residual is evidence about a team that no longer
# exists. At 0.85 a season eight years back carries 27% of this season's
# weight.
DEFAULT_DECAY_PER_SEASON = 0.85

# A cell with fewer than this many usable games is not fitted at all. Below
# about twenty the sampling variance is so large that empirical Bayes would
# shrink it to nothing anyway; this just says so directly instead of
# multiplying a wild number by a tiny one.
DEFAULT_MIN_GAMES = 20

# The hard cap, in points of win probability (the 0-100 scale everything in
# models/win_prob.py speaks). A backstop, not a working part -- see the
# docstring: under empirical Bayes nothing on the shipped sample comes near
# it. It exists so that a future refit on a thinner or stranger sample cannot
# silently start moving picks by double digits.
DEFAULT_MAX_ADJUSTMENT_PCT = 4.0

# Where the fitted table is written and read. The JS twin is written by the
# same command in the same run -- see the note in scripts/calibrate.py.
TABLE_PATH = Path(__file__).resolve().parent / "team_bias_table.json"
JS_TABLE_PATH = (
    Path(__file__).resolve().parent.parent
    / "deadpool" / "src" / "engine" / "team-bias-table.js"
)

# nflverse's abbreviation -> the one this app joins on.
#
# The table is fitted from nflverse history and read by an app whose every
# join key -- a pick, a used-teams list, a board cell -- is *ESPN's*
# abbreviation (see data/teams.py). Three disagree, and a mismatch here does
# not throw: it silently produces a team that never gets an adjustment, which
# is the quietest possible way for this to be broken.
#
# `OAK -> LV` also merges the Raiders' Oakland seasons into the Las Vegas
# cell. That is deliberate and it is the franchise-continuity reading: the
# residual is a claim about how the market prices *this team*, and the team
# did not change when the stadium did. The recency decay already discounts
# those seasons to under a third of a current one.
#
# Only the relocations inside a plausible fitting window are here. `SD` and
# `STL` last appear in 2016 and 2015 and would need adding if the window ever
# reached back that far -- at which point 0.85^11 = 0.17 says they would
# barely register anyway.
NFLVERSE_ALIASES = {
    "LA": "LAR",    # Rams
    "WAS": "WSH",   # Commanders
    "OAK": "LV",    # Raiders, pre-2020
}


def canonical_team(abbreviation: object) -> Optional[str]:
    """An nflverse team abbreviation as this app spells it."""
    if not abbreviation:
        return None
    name = str(abbreviation)
    return NFLVERSE_ALIASES.get(name, name)

# The two venue contexts, as they are spelled in the table.
HOME = "home"
AWAY = "away"

_table_cache: Optional[Dict[str, Dict[str, float]]] = None


def venue_key(is_home: bool) -> str:
    """The table's key for a venue context. One spelling, defined once."""
    return HOME if is_home else AWAY


def _number(value: object) -> Optional[float]:
    """A CSV cell as a float, or None. Empty means "not published", never zero."""
    if value is None or value == "" or value == "NA":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def market_home_share(row: Mapping[str, object]) -> Optional[float]:
    """One historical game's market-implied home win share, conditional on no tie.

    Deliberately the *same* two rungs, in the same order, that
    ``models.win_prob.resolve_team_win_probability`` uses -- the de-vigged
    moneyline pair first, then the fitted spread logistic -- and deliberately
    the same ``devig`` function rather than a second copy of it.

    That matters more than it looks. Fit the residual against a *different*
    market model than the one it will later correct and the "bias" quietly
    absorbs the disagreement between the two models: switch this to
    multiplicative de-vigging and every heavy favourite grows a fake positive
    residual worth about two points, because multiplicative reads 1.95 points
    lower than power exactly where survivor picks live. The correction would
    then be measuring our own inconsistency and calling it the market's.

    ``row`` is an nflverse ``games.csv`` record. Returns None when the game has
    neither a moneyline pair nor a posted line.
    """
    home_raw = implied_prob_from_moneyline(_number(row.get("home_moneyline")))
    away_raw = implied_prob_from_moneyline(_number(row.get("away_moneyline")))
    if home_raw is not None and away_raw is not None and home_raw + away_raw > 0:
        home_share, _away_share = devig(home_raw, away_raw, DEFAULT_DEVIG_METHOD)
        return home_share

    # nflverse's `spread_line` is positive when the home side is favoured,
    # which is already the convention the logistic was fitted in. (ESPN's
    # `spread` is the other way round and is negated in win_prob; do not
    # copy that negation here.)
    spread_line = _number(row.get("spread_line"))
    if spread_line is None:
        return None
    return home_share_from_spread_line(spread_line)


@dataclass(frozen=True)
class CellFit:
    """One (team, venue) cell's raw residual, before any shrinking.

    ``variance`` is the sampling variance of ``residual`` under the null that
    the market is perfectly calibrated for this team -- i.e. how far from zero
    this residual would wander on chance alone. It is what makes the shrinkage
    an estimate rather than a preference, so it is carried alongside the
    residual rather than recomputed later from ``weight``.
    """

    team: str
    venue: str
    residual: float     # weighted mean of (actual - predicted), share scale
    variance: float     # sampling variance of that weighted mean
    weight: float       # sum of recency weights -- the effective sample size
    games: int          # unweighted count, for reporting


def fit_cells(
    rows: Sequence[Mapping[str, object]],
    decay_per_season: float = DEFAULT_DECAY_PER_SEASON,
    min_games: int = DEFAULT_MIN_GAMES,
    latest_season: Optional[int] = None,
) -> List[CellFit]:
    """Every team/venue cell's raw weighted residual and its sampling variance.

    ``rows`` are nflverse ``games.csv`` records. Games with no score, no market
    basis, or a tied result are skipped; ties carry no win/loss label and are
    dropped for the same reason the spread logistic dropped them.

    ``latest_season`` anchors the recency decay, and defaults to the newest
    season present. It is shared across every cell on purpose: a team that
    happens not to have played in the newest season must not be handed a
    *younger* clock than everybody else, which would silently put heavier
    weight on its oldest games.

    Both sides of a game are recorded -- the home team into its "home" cell and
    the away team into its "away" cell -- so one game contributes one
    observation to each of two cells, which is what makes the two contexts
    separable at all.
    """
    seasons = [s for s in (_number(r.get("season")) for r in rows) if s is not None]
    if latest_season is None:
        if not seasons:
            return []
        latest_season = int(max(seasons))

    # (team, venue) -> [(weight, actual, predicted)]
    cells: Dict[Tuple[str, str], List[Tuple[float, float, float]]] = {}

    for row in rows:
        home_score = _number(row.get("home_score"))
        away_score = _number(row.get("away_score"))
        if home_score is None or away_score is None:
            continue                          # not played yet
        margin = home_score - away_score
        if margin == 0:
            continue                          # tie: no win/loss label

        home_share = market_home_share(row)
        if home_share is None:
            continue                          # no price and no line

        season = _number(row.get("season"))
        if season is None:
            continue

        home_team = canonical_team(row.get("home_team"))
        away_team = canonical_team(row.get("away_team"))
        if not home_team or not away_team:
            continue

        weight = decay_per_season ** (latest_season - season)
        home_won = 1.0 if margin > 0 else 0.0

        cells.setdefault((home_team, HOME), []).append((weight, home_won, home_share))
        cells.setdefault((away_team, AWAY), []).append(
            (weight, 1.0 - home_won, 1.0 - home_share)
        )

    fits: List[CellFit] = []
    for (team, venue), observations in cells.items():
        if len(observations) < min_games:
            continue
        weight_total = sum(w for w, _a, _p in observations)
        if weight_total <= 0:
            continue

        residual = sum(w * (a - p) for w, a, p in observations) / weight_total
        # Var of a weighted mean of independent Bernoulli(p_i):
        #   sum(w_i^2 * p_i(1-p_i)) / (sum w_i)^2
        variance = sum(w * w * p * (1.0 - p) for w, _a, p in observations) / (weight_total ** 2)

        fits.append(CellFit(
            team=team, venue=venue, residual=residual,
            variance=variance, weight=weight_total, games=len(observations),
        ))

    fits.sort(key=lambda c: (c.team, c.venue))
    return fits


def estimate_between_variance(cells: Sequence[CellFit]) -> float:
    """The between-team variance ``tau^2``, by moment matching.

    The observed spread of cell residuals is inflated by each cell's own
    sampling noise:

        var(observed) = tau^2 + mean(sampling variance)

    so ``tau^2`` is the first minus the second, floored at zero. Zero is a
    real and expected answer -- it means the cells are no more spread out than
    a perfectly calibrated market would make them, and every adjustment
    collapses to nothing. That is the correct behaviour, not a degenerate
    case, and it is why this returns a number rather than raising.

    Cells are weighted equally here rather than by sample size. The quantity
    being estimated is how much *teams* differ from each other, and a team is
    one team however many games it played.
    """
    n = len(cells)
    if n < 2:
        return 0.0

    mean = sum(c.residual for c in cells) / n
    observed = sum((c.residual - mean) ** 2 for c in cells) / (n - 1)
    sampling = sum(c.variance for c in cells) / n
    return max(0.0, observed - sampling)


def shrink_factor(cell: CellFit, between_variance: float) -> float:
    """How much of this cell's residual to keep: ``tau^2 / (tau^2 + s^2)``.

    Zero when there is no between-team variance to attribute anything to, and
    approaching one only for a cell whose own sampling noise is small compared
    with the real spread between teams. Note it is per cell, so a team with a
    thin history is shrunk harder than one with a long one -- which falls out
    of the formula rather than needing a rule.
    """
    denominator = between_variance + cell.variance
    if denominator <= 0:
        return 0.0
    return between_variance / denominator


def build_bias_table(
    rows: Sequence[Mapping[str, object]],
    decay_per_season: float = DEFAULT_DECAY_PER_SEASON,
    min_games: int = DEFAULT_MIN_GAMES,
    max_adjustment_pct: float = DEFAULT_MAX_ADJUSTMENT_PCT,
) -> Tuple[Dict[str, Dict[str, float]], List[CellFit], float]:
    """The shippable table, plus the fits and ``tau^2`` it was derived from.

    Returns ``(table, cells, between_variance)``. The second and third are
    returned rather than discarded because the calibration report's whole job
    is to show its working -- a table of adjustments with no account of how
    much of the raw residual survived is exactly the artefact this module's
    docstring exists to argue against.
    """
    cells = fit_cells(rows, decay_per_season, min_games)
    between_variance = estimate_between_variance(cells)

    table: Dict[str, Dict[str, float]] = {}
    for cell in cells:
        adjustment = cell.residual * shrink_factor(cell, between_variance) * 100.0
        adjustment = max(-max_adjustment_pct, min(max_adjustment_pct, adjustment))
        table.setdefault(cell.team, {})[cell.venue] = adjustment

    # Every fitted team carries both contexts, so a lookup never has to
    # distinguish "no adjustment" from "this venue was never fitted".
    for contexts in table.values():
        contexts.setdefault(HOME, 0.0)
        contexts.setdefault(AWAY, 0.0)

    return table, cells, between_variance


def load_bias_table(path: Optional[Path] = None) -> Dict[str, Dict[str, float]]:
    """The shipped table, read once and cached.

    A missing or malformed file returns an empty table rather than raising.
    This is a correction on top of a working model, and the model works
    without it -- a Week screen that cannot render because an optional JSON
    file is unreadable would be a far worse failure than no correction.
    """
    global _table_cache
    if path is None and _table_cache is not None:
        return _table_cache

    target = path or TABLE_PATH
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
        table = {
            str(team): {
                HOME: float(contexts.get(HOME, 0.0)),
                AWAY: float(contexts.get(AWAY, 0.0)),
            }
            for team, contexts in raw.get("teams", {}).items()
        }
    except (OSError, ValueError, AttributeError, TypeError):
        table = {}

    if path is None:
        _table_cache = table
    return table


def bias_for(
    table: Optional[Mapping[str, Mapping[str, float]]],
    team: Optional[str],
    is_home: bool,
) -> float:
    """One team's adjustment in one venue, in points. 0.0 when not in the table."""
    if not table or not team:
        return 0.0
    contexts = table.get(team)
    if not contexts:
        return 0.0
    try:
        return float(contexts.get(venue_key(is_home), 0.0))
    except (TypeError, ValueError):
        return 0.0


def table_summary(
    table: Mapping[str, Mapping[str, float]]
) -> List[Tuple[str, str, float]]:
    """Every (team, venue, points) entry, largest absolute adjustment first."""
    entries = [
        (team, venue, float(points))
        for team, contexts in table.items()
        for venue, points in contexts.items()
    ]
    entries.sort(key=lambda e: abs(e[2]), reverse=True)
    return entries
