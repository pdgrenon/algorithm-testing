"""A second opinion on every game, and what to do when it disagrees.

Everything else in this project reads one source: the market. That is a
defensible choice -- a liquid two-way price is the best single estimate
available -- but it is still one estimate, and a model with one input cannot
tell the difference between "this number is right" and "this number is the
only one I have".

nfelo is greerreNFL's open-source NFL Elo rating model. Its per-game output is
published as a CSV in the project's own repository, so this is a second
opinion that costs one fetch and no API key. This module is the arithmetic for
using it: putting it on the same scale as the market, blending the two, and
naming the gap between them.

── Blending happens in spread points, not in probability ───────────────────

The obvious implementation averages the two probabilities. This one converts
both to **points of spread**, averages there, and converts back.

The difference is not cosmetic, and it is largest exactly where survivor picks
live. Probability is a compressed scale at the ends: the gap between 90% and
95% is five points of probability and about four and a half points of spread,
while the gap between 50% and 55% is five points of probability and one and a
half points of spread. Averaging in probability space therefore treats a
half-goal disagreement about a coin flip as three times more important than
the same disagreement about a heavy favourite -- and heavy favourites are the
entire population this app picks from.

Spread points are the scale the model is actually linear in. That is not an
aesthetic claim: ``SPREAD_LOGISTIC_SLOPE`` exists because a logistic in the
spread is what fitted 3,018 real games. Blending on the scale a model was
fitted in is the ordinary thing to do; blending on a squashed transform of it
is the choice that needs defending.

Worked, at a 50/50 blend, market 92% and Elo 84%:

    in probability space   88.0%
    in spread space        88.6%     (+0.6 points)

Small, consistently in the direction of the more confident source, and it
grows with the disagreement.

This is also where the ported implementation this follows
(``ssgrenon/survivor-picker``) and this one part company: its commit titles
say "blend in spread space" but the code at its tip averages the two
probabilities directly. The spreads it computes are display-only. Here they
are load-bearing, which is a large part of why they are worth putting on
screen -- see ``divergence`` below.

── Divergence is the interesting output, not the blend ─────────────────────

``divergence = elo_spread - market_spread``: how many points the Elo model
would move the line, signed, and always in the **home team's** convention no
matter which side is being asked about. Positive means nfelo likes the home
team more than the market does.

Two properties are deliberate. It is *signed*, because "the models disagree by
three points" is much less useful than knowing which way. And it is fixed to
the home team rather than to whichever team was passed in, so one game
produces one number -- otherwise the same disagreement reads as +3 when
evaluating one side and -3 when evaluating the other, and a person comparing
two candidates in the same game would see a contradiction.

It is never a scoring input. It is computed the same way whatever the blend
weight is, including at 100% market where it changes nothing at all. What it
is for is the case the blend cannot express: the market says 91% and nfelo
says 78%, the blended number still looks safe, and the honest thing the screen
can do is say that the two models are four points apart on this one.

── What is off by default, and what is not ─────────────────────────────────

The blend is off: ``DEFAULT_MARKET_WEIGHT`` is 1.0, so out of the box the
number this app shows is the market's, exactly as before. Nothing here has
measured whether blending picks better teams, and the project this is ported
from moved its own default from 0.75 to reverted to 0.5 inside a single day on
an unpublished ten-season sweep. That is a knob to measure, not a finding to
adopt.

Divergence is *not* gated on the blend, because it costs nothing and it is
information rather than a decision.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, Mapping, Optional, Sequence

from models.market_curve import (
    home_share_from_spread_line,
    spread_line_from_home_share,
)

# The fraction of the blend drawn from the market, with the remainder from
# nfelo. 1.0 is market-only and is the default -- see the docstring.
DEFAULT_MARKET_WEIGHT = 1.0

# The column carrying nfelo's home-team win probability. "close" rather than
# "open" because it is the model's final pregame word on the game, which is
# the like-for-like comparison against a closing market price.
NFELO_HOME_PROBABILITY_COLUMN = "nfelo_home_probability_close"

# nfelo's game_id: SEASON_WW_AWAY_HOME, e.g. "2026_01_DAL_NYG". The same
# format nflverse uses, which is not a coincidence -- nfelo is built on it.
GAME_ID_PATTERN = re.compile(r"^(\d{4})_(\d{2})_([A-Z]+)_([A-Z]+)$")

# This app's abbreviation -> nfelo's.
#
# nfelo assigns one stable abbreviation per franchise across relocations,
# where this app uses ESPN's current-day one. Three differ, and every one of
# them is a team that moved. Verified against the live file: its 2009-2026
# game_ids contain exactly 32 abbreviations, including OAK and no LV, LAR and
# no LA, WAS and no WSH.
#
# A missing entry here does not throw -- it produces a game nfelo never
# matches, which silently falls back to market-only for that game and nowhere
# else. That is the failure mode to watch for if a future relocation is not
# added.
NFELO_ALIASES = {
    "LV": "OAK",     # Raiders -- nfelo keeps the Oakland abbreviation
    "LAR": "LAR",    # Rams -- same on both sides, listed so the set is visibly complete
    "WSH": "WAS",    # Commanders
}


def nfelo_team(abbreviation: Optional[str]) -> Optional[str]:
    """One of this app's team abbreviations as nfelo spells it."""
    if not abbreviation:
        return None
    return NFELO_ALIASES.get(abbreviation, abbreviation)


def nfelo_game_id(
    season: Optional[int],
    week: Optional[int],
    away_abbreviation: Optional[str],
    home_abbreviation: Optional[str],
) -> Optional[str]:
    """The nfelo/nflverse key for one game, or None if it cannot be built.

    Note the week is zero-padded to two digits and the away team comes first.
    Both are easy to get backwards and neither fails loudly -- the lookup just
    misses and the game quietly falls back to market-only.
    """
    away = nfelo_team(away_abbreviation)
    home = nfelo_team(home_abbreviation)
    if season is None or week is None or not away or not home:
        return None
    return f"{int(season)}_{int(week):02d}_{away}_{home}"


def parse_nfelo_rows(rows: Sequence[Mapping[str, object]]) -> Dict[str, float]:
    """nfelo's CSV records as ``{game_id: home_win_probability}``.

    Pure, and separate from the fetching in ``data/nfelo_client.py``, so the
    suite can exercise the parse without touching the network.

    Rows with an unparseable id or a missing/out-of-range probability are
    skipped rather than defaulted. A game absent from this table is a game
    that falls back to the market, which is the correct behaviour for a data
    lag and for a game nfelo does not cover.
    """
    table: Dict[str, float] = {}
    for row in rows:
        game_id = row.get("game_id")
        if not game_id or not GAME_ID_PATTERN.match(str(game_id)):
            continue
        raw = row.get(NFELO_HOME_PROBABILITY_COLUMN)
        if raw is None or raw == "" or raw == "NA":
            continue
        try:
            probability = float(raw)
        except (TypeError, ValueError):
            continue
        if not 0.0 < probability < 1.0:
            continue
        table[str(game_id)] = probability
    return table


def home_win_share(
    table: Optional[Mapping[str, float]],
    season: Optional[int],
    week: Optional[int],
    away_abbreviation: Optional[str],
    home_abbreviation: Optional[str],
) -> Optional[float]:
    """nfelo's home-team win share for one game, or None when it has no rating.

    The share is conditional on no tie, matching a two-way price and matching
    what ``home_share_from_spread_line`` returns -- so it can be compared with
    the market's on equal terms without a conversion step.
    """
    if not table:
        return None
    game_id = nfelo_game_id(season, week, away_abbreviation, home_abbreviation)
    if game_id is None:
        return None
    return table.get(game_id)


@dataclass(frozen=True)
class ModelComparison:
    """What the two models say about one game, and their blend.

    Every spread here is in the **home team's** convention -- positive means
    the home side is favoured -- regardless of which team was being evaluated.
    See the module docstring for why that is fixed rather than relative.

    ``elo_spread`` and ``divergence`` are None whenever nfelo had no rating for
    the game, which is an ordinary Sunday rather than an error: the table lags
    the schedule, and a game it has not published yet simply uses the market.
    """

    market_spread: float
    elo_spread: Optional[float]
    divergence: Optional[float]
    blended_home_share: float
    market_weight: float

    @property
    def blended(self) -> bool:
        """Whether the blend actually moved anything for this game."""
        return self.elo_spread is not None and self.market_weight < 1.0


def compare_models(
    market_home_share: float,
    elo_home_share: Optional[float],
    market_weight: float = DEFAULT_MARKET_WEIGHT,
) -> ModelComparison:
    """Put both models on the spread scale, blend there, and name the gap.

    ``market_weight`` is the fraction drawn from the market; 1.0 is
    market-only. Out-of-range values are clamped rather than rejected -- this
    sits behind a slider, and a stored setting from an older build must not be
    able to stop the Week screen rendering.

    With no Elo rating the blend is the market, unchanged and bit-identical to
    not calling this at all. That property is what lets the comparison be
    computed unconditionally and the blend be off by default.
    """
    weight = min(1.0, max(0.0, float(market_weight)))
    market_spread = spread_line_from_home_share(market_home_share)

    if elo_home_share is None:
        return ModelComparison(
            market_spread=market_spread,
            elo_spread=None,
            divergence=None,
            blended_home_share=market_home_share,
            market_weight=weight,
        )

    elo_spread = spread_line_from_home_share(elo_home_share)
    divergence = elo_spread - market_spread

    if weight >= 1.0:
        # Deliberately returns the *original* share rather than round-tripping
        # it through the logistic and back. The two agree to about 1e-16, and
        # "the blend is off" has to mean exactly the number the market gave,
        # not a number that differs from it in the last few bits -- otherwise
        # every golden fixture moves the day this is wired in.
        blended_share = market_home_share
    else:
        blended_spread = weight * market_spread + (1.0 - weight) * elo_spread
        blended_share = home_share_from_spread_line(blended_spread)

    return ModelComparison(
        market_spread=market_spread,
        elo_spread=elo_spread,
        divergence=divergence,
        blended_home_share=blended_share,
        market_weight=weight,
    )
