"""Plan a sequence of picks, rather than score this week's in isolation.

``models/future_value.py`` answers "is a better spot coming for this team?" by
discounting each of its next few matchups and comparing the best to this week's.
That is a per-team heuristic standing in for a question that has an exact
answer: **which sequence of distinct teams over the next N weeks maximises the
probability of surviving all of them?**

The difference is not academic. The heuristic looks at one team at a time, so
it cannot see that holding a team back only pays if something else covers this
week, and it cannot notice that two teams it wants to hold are wanted for the
same future week. A sequence search sees both, because it is choosing the
sequence.

    survival(t1..tN) = P(w1 wins) x P(w2 wins) x ... x P(wN wins)

maximised over assignments of distinct teams to weeks. Only the first step is
meant to be acted on -- next week the board, the odds and the used-teams set
have all moved, so the plan is recomputed. The rest of the path is returned for
display, which is the honest framing: it is a projection, not a commitment.

── Why a bitmask DP, and why it is tractable ───────────────────────────────

Exhaustive over the whole league is 2^32 states and hopeless. Two prunes make
it small enough to be exact over what is left:

  * each week keeps only its ``per_week_top_k`` best teams -- a team outside a
    week's top six is not the pick that week under any plan, because every
    term in the product is a win probability and a lower one cannot help;
  * the union of those is capped at ``max_candidate_teams``, keeping the teams
    with the highest best-any-week probability.

The cap is soft on purpose. Trimming can strip a week bare -- a week where
every good team is wanted elsewhere -- and a week with no candidates makes the
whole search fail. So a week left empty gets its own best team added back,
additively, never evicting a team kept for another week's sake.

What that costs in honesty: the result is exact over the pruned universe and
not over the league. It is not "the optimal sequence"; it is the optimal
sequence among plausible teams, which is a different and smaller claim.

── The product, and what it assumes ────────────────────────────────────────

Multiplying the weeks together treats them as independent, which they are not
quite -- the same team's form carries across weeks, and a market that is wrong
about a team is wrong about them repeatedly. Nothing here models that, and a
sequence probability should be read as a ranking device rather than a number to
quote. It is stated in the reasoning as a comparison between plans, never as
"you have a 31% chance of surviving to week 8".
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Set, Tuple

from data.models import Game
from models.win_prob import (
    TeamWeekWinProbability,
    basis_phrase,
    resolve_team_win_probability,
)

# How many weeks ahead to plan over, including the current one.
DEFAULT_LOOKAHEAD_WEEKS = 7

# How many of a week's best teams are considered for that week at all.
DEFAULT_PER_WEEK_TOP_K = 6

# Soft cap on distinct teams tracked across the whole window. Soft because
# every week is still guaranteed at least one candidate; see the docstring.
DEFAULT_MAX_CANDIDATE_TEAMS = 14


@dataclass
class WeekPick:
    """One team's matchup and win probability for one specific week."""

    week: int
    team_abbreviation: str
    opponent_abbreviation: Optional[str]
    is_home: bool
    win_pct: float           # 0-100
    win_pct_source: str
    spread_detail: Optional[str]
    event_id: Optional[str]


@dataclass
class SequenceRecommendation:
    week: int
    pick: Optional[WeekPick]
    path: List[WeekPick] = field(default_factory=list)
    survival_pct: Optional[float] = None      # 0-100, over the whole window
    candidate_universe: List[str] = field(default_factory=list)
    reasoning: str = ""


def _options_this_week(games: Sequence[Game], excluded: Set[str]) -> List[WeekPick]:
    """This week's candidates, from the games in hand.

    The current week comes from the games rather than from the table because
    the games carry the spread text and the event id the interface draws, and
    because a cached table may be a staler copy of the same week.
    """
    options: List[WeekPick] = []
    for game in games:
        if game.state and game.state != "pre":
            continue
        spread_detail = game.odds.details if game.odds else None
        for is_home in (True, False):
            team = game.home if is_home else game.away
            opponent = game.away if is_home else game.home
            if not team.abbreviation or team.abbreviation in excluded:
                continue
            resolved = resolve_team_win_probability(game, is_home)
            if resolved.win_pct is None:
                continue  # nothing to multiply
            options.append(
                WeekPick(
                    week=game.week,
                    team_abbreviation=team.abbreviation,
                    opponent_abbreviation=opponent.abbreviation,
                    is_home=is_home,
                    win_pct=resolved.win_pct,
                    win_pct_source=resolved.source,
                    spread_detail=spread_detail,
                    event_id=game.event_id,
                )
            )
    options.sort(key=lambda o: (-o.win_pct, o.team_abbreviation))
    return options


def _options_from_table(
    table: Dict[Tuple[str, int], TeamWeekWinProbability],
    week: int,
    excluded: Set[str],
) -> List[WeekPick]:
    """A future week's candidates, from the season-wide win probability table.

    Future weeks come from the table rather than from raw games because the
    table is what both engines carry -- `entry_a_value` reads it for exactly
    the same reason -- and because nothing about a future week is drawn on
    screen, so the spread text and event id are not needed and are left unset
    rather than invented.
    """
    options: List[WeekPick] = []
    for (team, entry_week), entry in table.items():
        if entry_week != week or team in excluded or entry.win_pct is None:
            continue
        options.append(
            WeekPick(
                week=week,
                team_abbreviation=team,
                opponent_abbreviation=entry.opponent_abbreviation,
                is_home=entry.is_home,
                win_pct=entry.win_pct,
                win_pct_source=entry.source,
                spread_detail=None,
                event_id=None,
            )
        )
    options.sort(key=lambda o: (-o.win_pct, o.team_abbreviation))
    return options


def build_candidate_universe(
    weekly_options: Dict[int, List[WeekPick]],
    per_week_top_k: int = DEFAULT_PER_WEEK_TOP_K,
    max_candidate_teams: int = DEFAULT_MAX_CANDIDATE_TEAMS,
) -> Dict[int, List[WeekPick]]:
    """Prune each week's options to a small, searchable universe.

    Each input list is assumed already best-first. See the module docstring for
    why the cap is additive-only.
    """
    topk = {week: options[:per_week_top_k] for week, options in weekly_options.items()}

    best_anywhere: Dict[str, float] = {}
    for options in topk.values():
        for option in options:
            team = option.team_abbreviation
            best_anywhere[team] = max(best_anywhere.get(team, 0.0), option.win_pct)

    kept: Set[str] = set()
    for team in sorted(best_anywhere, key=lambda t: (-best_anywhere[t], t)):
        if len(kept) >= max_candidate_teams:
            break
        kept.add(team)

    for _week, options in sorted(topk.items()):
        if options and not any(o.team_abbreviation in kept for o in options):
            kept.add(options[0].team_abbreviation)

    return {
        week: [o for o in options if o.team_abbreviation in kept]
        for week, options in topk.items()
    }


def solve(weekly_options: Dict[int, List[WeekPick]]) -> Tuple[float, List[WeekPick]]:
    """The all-distinct-teams sequence maximising the product of win probabilities.

    A bitmask over the candidate universe: ``dp`` maps a set of teams already
    spent to the best product that reaches it, and the path that did. Returns
    ``(product, path)`` with the product on a 0-1 scale, or ``(0.0, [])`` when
    no week has a candidate.

    A week with no options left is skipped rather than failing the search. That
    is the difference between "there is no plan" and "there is no plan that
    also covers week 12", and only the first is worth refusing -- the traveler
    is acting on step one either way.
    """
    ordered_weeks = sorted(weekly_options)
    universe = sorted({o.team_abbreviation for os in weekly_options.values() for o in os})
    index_of = {team: i for i, team in enumerate(universe)}

    dp: Dict[int, Tuple[float, List[WeekPick]]] = {0: (1.0, [])}
    for week in ordered_weeks:
        options = weekly_options[week]
        if not options:
            continue
        nxt: Dict[int, Tuple[float, List[WeekPick]]] = {}
        for mask, (product, path) in dp.items():
            for option in options:
                bit = 1 << index_of[option.team_abbreviation]
                if mask & bit:
                    continue  # already spent earlier in this candidate sequence
                new_mask = mask | bit
                new_product = product * (option.win_pct / 100.0)
                current = nxt.get(new_mask)
                if current is None or new_product > current[0]:
                    nxt[new_mask] = (new_product, path + [option])
        if not nxt:
            # Every candidate this week was already spent by every surviving
            # sequence. Carry the sequences forward rather than dropping them.
            continue
        dp = nxt

    if not dp or dp == {0: (1.0, [])}:
        return 0.0, []
    best_mask = max(dp, key=lambda m: (dp[m][0], -len(dp[m][1])))
    return dp[best_mask]


def _describe(option: WeekPick) -> str:
    basis = basis_phrase(option.win_pct_source)
    spread = f", spread {option.spread_detail}" if option.spread_detail else ""
    return (
        f"{option.team_abbreviation} vs {option.opponent_abbreviation or '?'} -- "
        f"{option.win_pct:.1f}% win prob{basis}{spread}"
    )


def _build_reasoning(
    pick: WeekPick, path: List[WeekPick], product: float, universe: List[str]
) -> str:
    parts = [f"Top pick: {_describe(pick)}."]
    if len(path) > 1:
        plan = ", ".join(f"wk {p.week} {p.team_abbreviation}" for p in path[1:])
        parts.append(
            f"Chosen as the first step of the best {len(path)}-week sequence "
            f"({plan}), searched over {len(universe)} candidate teams."
        )
        parts.append(
            f"That whole sequence comes out at {product * 100:.1f}% to survive, treating the "
            f"weeks as independent -- a way of ranking plans against each other rather than a "
            f"figure to quote."
        )
    else:
        parts.append(
            "Only this week had candidates, so no sequence was searched and this is "
            "the highest win probability available."
        )
    parts.append("Only this week's pick is meant to be acted on; the rest is recomputed next week.")
    return " ".join(parts)


def recommend(
    current_week_games: Sequence[Game],
    win_prob_table: Dict[Tuple[str, int], TeamWeekWinProbability],
    current_week: int,
    used_teams: Optional[List[str]] = None,
    lookahead_weeks: int = DEFAULT_LOOKAHEAD_WEEKS,
    per_week_top_k: int = DEFAULT_PER_WEEK_TOP_K,
    max_candidate_teams: int = DEFAULT_MAX_CANDIDATE_TEAMS,
) -> SequenceRecommendation:
    """This week's pick, as the first step of the best sequence over the window.

    Same signature as `entry_a_value.recommend` on purpose: this week from the
    games in hand, the future from the season table. Given a table that does
    not extend past the current week it degenerates to picking the highest win
    probability, which is said in the reasoning rather than left to look like a
    plan -- the same failure `entry_a_value` documents for its own lookahead.
    """
    used = list(used_teams or [])
    excluded = set(used)

    weekly: Dict[int, List[WeekPick]] = {}
    this_week = _options_this_week(current_week_games, excluded)
    if this_week:
        weekly[current_week] = this_week
    for week in range(current_week + 1, current_week + lookahead_weeks):
        options = _options_from_table(win_prob_table, week, excluded)
        if options:
            weekly[week] = options

    if current_week not in weekly:
        return SequenceRecommendation(
            week=current_week,
            pick=None,
            reasoning="No eligible teams available this week (all used, or no game data).",
        )

    universe_options = build_candidate_universe(weekly, per_week_top_k, max_candidate_teams)
    product, path = solve(universe_options)

    if not path or path[0].week != current_week:
        best = weekly[current_week][0]
        return SequenceRecommendation(
            week=current_week,
            pick=best,
            path=[best],
            survival_pct=best.win_pct,
            candidate_universe=[best.team_abbreviation],
            reasoning=(
                f"Top pick: {_describe(best)}. No multi-week sequence could be built from this "
                f"board, so this is the highest win probability available."
            ),
        )

    universe = sorted({o.team_abbreviation for os in universe_options.values() for o in os})
    return SequenceRecommendation(
        week=current_week,
        pick=path[0],
        path=path,
        survival_pct=product * 100.0,
        candidate_universe=universe,
        reasoning=_build_reasoning(path[0], path, product, universe),
    )
