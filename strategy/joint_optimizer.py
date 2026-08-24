"""Joint pick optimizer: choose Entry A's and Entry B's picks together.

Unlike ``entry_a_value.py`` (optimizes Entry A alone) and
``entry_b_hedge.py`` (hedges Entry B against an already-fixed Entry A
pick), this module searches every valid ``(team_a, team_b)`` pair at once
and picks the one that maximizes:

    P(A wins) + P(B wins) - P(A loses AND B loses)

assuming independence between different games. The pair is always required
to come from two different games (see the constraints below), so that
independence assumption holds by construction -- we never need to reason
about two teams whose outcomes are perfectly correlated because they're
playing each other.

A pair is only considered if it:
  * never repeats a team either entry has already used this season
  * never picks the same team for both entries in the same week
  * never puts the two entries on opposing sides of the same game (since a
    game only has two teams, this is equivalent to: never pick two teams
    from the same game at all)
  * keeps Entry B's win probability at or above a configurable floor
    (default 65%), so B doesn't sacrifice safety purely to diversify away
    from A -- unless nothing clears the floor, in which case the floor is
    relaxed and that's called out in the reasoning rather than silently
    leaving Entry B without a pick.

The search space is small (at most ~2x the number of games per entry), so
this is a plain brute-force scan over all pairs, not an ILP/solver.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from data.models import Game
from models.win_prob import basis_phrase, resolve_team_win_probability
from state.entries_store import load_used_teams_for_entry
from strategy.entry_b_hedge import DEFAULT_MIN_WIN_PROB_FLOOR as DEFAULT_MIN_WIN_PROB_FLOOR_B
from strategy.entry_b_hedge import meets_win_prob_floor

ENTRY_A_NAME = "Entry A"
ENTRY_B_NAME = "Entry B"


@dataclass
class TeamOption:
    team_abbreviation: str
    opponent_abbreviation: Optional[str]
    event_id: Optional[str]
    win_pct: Optional[float]  # 0-100, may be spread-estimated
    win_pct_source: str  # "api" | "spread_estimate" | "unknown"
    spread_detail: Optional[str]


@dataclass
class PairScore:
    pick_a: TeamOption
    pick_b: TeamOption
    both_survive_pct: float
    one_survives_pct: float
    both_eliminated_pct: float
    objective_score: float


@dataclass
class JointSearchResult:
    best: Optional[PairScore]
    runner_up: Optional[PairScore]
    floor_relaxed: bool
    pairs_considered: int


@dataclass
class JointRecommendation:
    week: int
    pick_a: Optional[TeamOption]
    pick_b: Optional[TeamOption]
    both_survive_pct: Optional[float]
    one_survives_pct: Optional[float]
    both_eliminated_pct: Optional[float]
    reasoning: str
    floor_relaxed: bool = False
    pairs_considered: int = 0


def build_team_options(current_week_games: List[Game]) -> List[TeamOption]:
    """All teams playing a not-yet-started game this week, with win prob/spread."""
    options: List[TeamOption] = []
    for game in current_week_games:
        if game.state and game.state != "pre":
            continue
        spread_detail = game.odds.details if game.odds else None
        for team, opponent, is_home in ((game.home, game.away, True), (game.away, game.home, False)):
            if not team.abbreviation:
                continue
            resolved = resolve_team_win_probability(game, is_home)
            options.append(
                TeamOption(
                    team_abbreviation=team.abbreviation,
                    opponent_abbreviation=opponent.abbreviation,
                    event_id=game.event_id,
                    win_pct=resolved.win_pct,
                    win_pct_source=resolved.source,
                    spread_detail=spread_detail,
                )
            )
    return options


def _score_pair(a: TeamOption, b: TeamOption) -> PairScore:
    p_a = a.win_pct / 100.0
    p_b = b.win_pct / 100.0
    both_survive = p_a * p_b
    both_eliminated = (1 - p_a) * (1 - p_b)
    one_survives = 1.0 - both_survive - both_eliminated
    objective = p_a + p_b - both_eliminated
    return PairScore(
        pick_a=a,
        pick_b=b,
        both_survive_pct=both_survive * 100.0,
        one_survives_pct=one_survives * 100.0,
        both_eliminated_pct=both_eliminated * 100.0,
        objective_score=objective,
    )


def _same_game(a: TeamOption, b: TeamOption) -> bool:
    """Whether two options are opposite sides of one result.

    The event id answers this whenever there is one. Where there is not, the
    opponents do: two options are the two halves of one game exactly when each
    names the other as its opponent. `build_team_options` fills both fields
    together, so an option carrying one carries the other.

    The id alone used to be the whole test, which fails *open* -- a missing id
    on either side returned False, and the pair search read that as "different
    games". That is the guarantee this strategy is named for, and `_describe`
    goes on to print "Different games ..., so one result cannot end both"
    without re-checking, so the failure arrives with a sentence asserting the
    opposite. `_score_pair` mis-scores it too, computing (1-pA)(1-pB) for an
    outcome whose real probability is zero.

    ESPN has always sent `event.id`, so nobody has hit this. It is the
    degradation `safe_get` exists to survive: a renamed field becomes None
    rather than a crash, and the guards downstream are supposed to hold.
    """
    if a.event_id is not None and b.event_id is not None:
        return a.event_id == b.event_id
    return (
        (a.opponent_abbreviation is not None and a.opponent_abbreviation == b.team_abbreviation)
        or (b.opponent_abbreviation is not None and b.opponent_abbreviation == a.team_abbreviation)
    )


def find_best_pair(
    current_week_games: List[Game],
    used_teams_a: List[str],
    used_teams_b: List[str],
    min_win_prob_floor_b: float = DEFAULT_MIN_WIN_PROB_FLOOR_B,
) -> JointSearchResult:
    """Pure brute-force search over all constraint-satisfying (team_a, team_b) pairs."""
    options = build_team_options(current_week_games)

    available_a = [o for o in options if o.team_abbreviation not in used_teams_a and o.win_pct is not None]
    available_b_all = [o for o in options if o.team_abbreviation not in used_teams_b and o.win_pct is not None]
    available_b = [o for o in available_b_all if meets_win_prob_floor(o.win_pct, min_win_prob_floor_b)]

    floor_relaxed = False
    if not available_b and available_b_all:
        available_b = available_b_all
        floor_relaxed = True

    scored: List[PairScore] = []
    for a in available_a:
        for b in available_b:
            if a.team_abbreviation == b.team_abbreviation:
                continue
            if _same_game(a, b):
                continue  # same game -- opposing sides
            scored.append(_score_pair(a, b))

    scored.sort(key=lambda p: (-p.objective_score, p.pick_a.team_abbreviation, p.pick_b.team_abbreviation))

    best = scored[0] if scored else None
    # The same two teams with A/B swapped scores identically (the objective is
    # symmetric) but isn't a meaningfully different alternative -- skip past
    # any such swaps to find a genuinely different runner-up pairing, if one
    # exists.
    runner_up = None
    if best is not None:
        best_team_set = {best.pick_a.team_abbreviation, best.pick_b.team_abbreviation}
        for candidate in scored[1:]:
            if {candidate.pick_a.team_abbreviation, candidate.pick_b.team_abbreviation} != best_team_set:
                runner_up = candidate
                break
    return JointSearchResult(
        best=best, runner_up=runner_up, floor_relaxed=floor_relaxed, pairs_considered=len(scored)
    )


def _describe(option: TeamOption) -> str:
    win_pct = f"{option.win_pct:.1f}%" if option.win_pct is not None else "unknown"
    basis = basis_phrase(option.win_pct_source)
    spread = f", spread {option.spread_detail}" if option.spread_detail else ""
    return f"{option.team_abbreviation} vs {option.opponent_abbreviation or '?'} -- {win_pct} win prob{basis}{spread}"


def _build_reasoning(
    pair: PairScore, floor_relaxed: bool, min_win_prob_floor_b: float, runner_up: Optional[PairScore]
) -> str:
    """A few sentences, shown per pick on a phone and in the CLI report.

    Three things were dropped from this because the screen already carried
    them, and saying them twice is what made the panel a wall of text:

    * the both-survive / one-survives / both-eliminated split, which the view
      renders as its own factor rows above this prose -- see the `odds` array
      in the registry contract below.
    * "Entry B's pick clears the N% floor", which fired on every ordinary week
      and so told nobody anything. The interesting case is the floor being
      *relaxed*, and that still says so, loudly, and also raises a warning.
    * the objective scores behind the runner-up comparison. Which pairing won
      is worth knowing; that it scored 1.875 against 1.857 on a combined
      objective is not a number anybody can act on.

    Same treatment as the strategy notes in deadpool/src/engine/measured.js;
    see the comment above MEASURED there.
    """
    parts = [
        f"Entry A: {_describe(pair.pick_a)}.",
        f"Entry B: {_describe(pair.pick_b)}.",
    ]

    if floor_relaxed:
        parts.append(
            f"No team available to Entry B cleared the {min_win_prob_floor_b:.0f}% floor this week; "
            f"the floor was relaxed rather than leave Entry B without a pick."
        )

    parts.append(
        f"Different games (A faces {pair.pick_a.opponent_abbreviation or '?'}, "
        f"B faces {pair.pick_b.opponent_abbreviation or '?'}), so one result cannot end both."
    )

    if runner_up is not None:
        parts.append(
            f"Beat the next-best pairing, {runner_up.pick_a.team_abbreviation}/"
            f"{runner_up.pick_b.team_abbreviation}."
        )

    return " ".join(parts)


def recommend(
    current_week_games: List[Game],
    current_week: int,
    used_teams_a: Optional[List[str]] = None,
    used_teams_b: Optional[List[str]] = None,
    min_win_prob_floor_b: float = DEFAULT_MIN_WIN_PROB_FLOOR_B,
) -> JointRecommendation:
    """Jointly optimized picks for both entries, with reasoning.

    ``used_teams_a``/``used_teams_b`` default to loading
    ``state/used_teams_a.json`` / ``state/used_teams_b.json``.
    """
    if used_teams_a is None:
        used_teams_a = load_used_teams_for_entry(ENTRY_A_NAME)
    if used_teams_b is None:
        used_teams_b = load_used_teams_for_entry(ENTRY_B_NAME)

    search = find_best_pair(current_week_games, used_teams_a, used_teams_b, min_win_prob_floor_b)

    if search.best is None:
        return JointRecommendation(
            week=current_week,
            pick_a=None,
            pick_b=None,
            both_survive_pct=None,
            one_survives_pct=None,
            both_eliminated_pct=None,
            reasoning="No valid pick pair available this week (not enough eligible teams/games for both entries).",
            floor_relaxed=search.floor_relaxed,
            pairs_considered=search.pairs_considered,
        )

    best = search.best
    return JointRecommendation(
        week=current_week,
        pick_a=best.pick_a,
        pick_b=best.pick_b,
        both_survive_pct=best.both_survive_pct,
        one_survives_pct=best.one_survives_pct,
        both_eliminated_pct=best.both_eliminated_pct,
        reasoning=_build_reasoning(best, search.floor_relaxed, min_win_prob_floor_b, search.runner_up),
        floor_relaxed=search.floor_relaxed,
        pairs_considered=search.pairs_considered,
    )
