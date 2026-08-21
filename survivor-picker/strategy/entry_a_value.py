"""Weekly pick strategy for Entry A.

Combines this week's win probabilities (``models.win_prob``) with each
team's future value (``models.future_value``) into a single score:

    score = win_pct * (1 - future_value_penalty)

``future_value_penalty`` is how much we discount a team for this week
because a materially better matchup is projected in the next few weeks --
so a big favorite with an even bigger mismatch coming up in a week or two
can rank behind a smaller, "use it now" favorite. The penalty is capped
(see ``MAX_FUTURE_VALUE_PENALTY``) so a distant hypothetical matchup can
never fully override a strong matchup in hand.

This module only reasons about Entry A -- ``used_teams_a.json`` via
``state/entries_store.py``. It produces a ranked list and a top pick with
plain-English reasoning; it never submits anything.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from data.models import Game
from models.future_value import DEFAULT_DECAY_RATE, DEFAULT_LOOKAHEAD_WEEKS, compute_future_value
from models.win_prob import TeamWeekWinProbability, resolve_team_win_probability
from state.entries_store import load_used_teams_for_entry

ENTRY_NAME = "Entry A"

# A future_value of this many win-probability points (or more) maps to the
# full penalty cap below. E.g. with the defaults, a future matchup that's
# 40 points better (after decay) than this week's caps the discount at 35%.
FUTURE_VALUE_PENALTY_SCALE = 40.0
MAX_FUTURE_VALUE_PENALTY = 0.35


@dataclass
class RankedPick:
    team_abbreviation: str
    opponent_abbreviation: Optional[str]
    win_pct: Optional[float]  # 0-100, may be spread-estimated
    win_pct_source: str  # "api" | "spread_estimate" | "unknown"
    spread_detail: Optional[str]
    future_value: Optional[float]  # points of upside from holding this team back, may be negative/None
    future_value_penalty: float  # 0 to MAX_FUTURE_VALUE_PENALTY, fraction actually applied
    score: Optional[float]  # win_pct * (1 - future_value_penalty), None if win_pct is unknown


@dataclass
class EntryARecommendation:
    week: int
    pick: Optional[RankedPick]
    reasoning: str
    alternatives: List[RankedPick] = field(default_factory=list)


def _future_value_to_penalty(future_value: Optional[float]) -> float:
    """Map a future_value (win-pct-point delta) to a capped 0-1 penalty.

    Only a *positive* future_value (a better matchup projected later)
    produces a penalty -- there's never a bonus for a team with nothing
    better coming up.
    """
    if future_value is None or future_value <= 0:
        return 0.0
    return min(MAX_FUTURE_VALUE_PENALTY, future_value / FUTURE_VALUE_PENALTY_SCALE)


def rank_available_teams(
    current_week_games: List[Game],
    win_prob_table: Dict[Tuple[str, int], TeamWeekWinProbability],
    used_teams: List[str],
    current_week: int,
    lookahead_weeks: int = DEFAULT_LOOKAHEAD_WEEKS,
    decay_rate: float = DEFAULT_DECAY_RATE,
) -> List[RankedPick]:
    """Rank this week's not-yet-used teams by ``win_pct * (1 - future_value_penalty)``.

    ``current_week_games`` supplies this week's win probability and spread
    per team; ``win_prob_table`` (spanning the season, built by
    ``models.win_prob.build_win_probability_table``) supplies the future
    matchups used to compute each team's future value. A team with no
    ``win_pct`` at all (score ``None``) sorts last -- there's no basis to
    recommend it over a team we can actually score.
    """
    ranked: List[RankedPick] = []

    for game in current_week_games:
        if game.state and game.state != "pre":
            continue  # already started/finished isn't a legitimate pick for this week
        spread_detail = game.odds.details if game.odds else None

        for team, opponent, is_home in ((game.home, game.away, True), (game.away, game.home, False)):
            if not team.abbreviation or team.abbreviation in used_teams:
                continue

            resolved = resolve_team_win_probability(game, is_home)
            # This week's resolved win_pct is the baseline -- not a lookup
            # into win_prob_table for the current week, which may not
            # include it (or may be a stale cached copy of it).
            remaining_schedule = [
                entry
                for (abbrev, wk), entry in win_prob_table.items()
                if abbrev == team.abbreviation and wk > current_week
            ]
            future = compute_future_value(
                team.abbreviation,
                current_week,
                resolved.win_pct,
                remaining_schedule,
                lookahead_weeks=lookahead_weeks,
                decay_rate=decay_rate,
            )
            penalty = _future_value_to_penalty(future.future_value)
            score = resolved.win_pct * (1 - penalty) if resolved.win_pct is not None else None

            ranked.append(
                RankedPick(
                    team_abbreviation=team.abbreviation,
                    opponent_abbreviation=opponent.abbreviation,
                    win_pct=resolved.win_pct,
                    win_pct_source=resolved.source,
                    spread_detail=spread_detail,
                    future_value=future.future_value,
                    future_value_penalty=penalty,
                    score=score,
                )
            )

    ranked.sort(key=lambda p: (p.score is None, -(p.score or 0)))
    return ranked


def _describe_pick(pick: RankedPick) -> str:
    win_pct = f"{pick.win_pct:.1f}%" if pick.win_pct is not None else "unknown"
    basis = " (estimated from spread)" if pick.win_pct_source == "spread_estimate" else ""
    spread = f", spread {pick.spread_detail}" if pick.spread_detail else ""
    return f"{pick.team_abbreviation} vs {pick.opponent_abbreviation or '?'} -- {win_pct} win prob{basis}{spread}"


def _build_reasoning(top: RankedPick, alternatives: List[RankedPick]) -> str:
    parts = [f"Top pick: {_describe_pick(top)}."]

    if top.score is None:
        parts.append("No win probability data was available for this pick; it was chosen by default ordering.")
    elif top.future_value_penalty > 0:
        parts.append(
            f"A future-value penalty of {top.future_value_penalty:.0%} was applied "
            f"(a projected future matchup is about {top.future_value:.1f} points better after decay), "
            f"but {top.team_abbreviation} still scored highest at {top.score:.1f}."
        )
    else:
        parts.append(
            f"No upcoming matchup is projected to beat this week's, so there's little value in holding "
            f"{top.team_abbreviation} back -- it scored {top.score:.1f} with no penalty applied."
        )

    if alternatives:
        runner_up = alternatives[0]
        runner_score = f"{runner_up.score:.1f}" if runner_up.score is not None else "unknown"
        top_score = f"{top.score:.1f}" if top.score is not None else "unknown"
        parts.append(f"Next best was {_describe_pick(runner_up)}, scoring {runner_score} vs {top_score}.")

    return " ".join(parts)


def recommend(
    current_week_games: List[Game],
    win_prob_table: Dict[Tuple[str, int], TeamWeekWinProbability],
    current_week: int,
    lookahead_weeks: int = DEFAULT_LOOKAHEAD_WEEKS,
    decay_rate: float = DEFAULT_DECAY_RATE,
    used_teams: Optional[List[str]] = None,
) -> EntryARecommendation:
    """Top pick recommendation for Entry A this week, with reasoning.

    ``used_teams`` defaults to loading ``state/used_teams_a.json``; pass it
    explicitly to keep this function pure for testing.
    """
    if used_teams is None:
        used_teams = load_used_teams_for_entry(ENTRY_NAME)

    ranked = rank_available_teams(
        current_week_games, win_prob_table, used_teams, current_week, lookahead_weeks, decay_rate
    )

    if not ranked:
        return EntryARecommendation(
            week=current_week,
            pick=None,
            reasoning="No eligible teams available this week (all used, or no game data).",
            alternatives=[],
        )

    top, alternatives = ranked[0], ranked[1:]
    return EntryARecommendation(
        week=current_week,
        pick=top,
        reasoning=_build_reasoning(top, alternatives),
        alternatives=alternatives,
    )
