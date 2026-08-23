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

    E[weeks survived] = sum over i of ( product of p_1 .. p_i )

maximised over assignments of distinct teams to weeks. Only the first step is
meant to be acted on -- next week the board, the odds and the used-teams set
have all moved, so the plan is recomputed. The rest of the path is returned for
display, which is the honest framing: it is a projection, not a commitment.

── Why expected weeks and not the product ──────────────────────────────────

This maximised the plain product of win probabilities until the pool's payout
rule was pinned down. The product answers "will I go unbeaten", which is only
the question if the pot needs a perfect season to be claimed. It does not here:
at 250 entries the expected number of unbeaten entries is 0.87, so the modal
season ends with **nobody** perfect and the deepest survivors splitting the pot
(see models/payout.py). Depth pays directly, and a week of survival is worth
something on its own.

Expected weeks is the objective that notices, and the difference is not
cosmetic -- it is **order-sensitive** where the product is blind::

    plan A   0.90 then 0.50    product 0.450    expected weeks 1.350
    plan B   0.50 then 0.90    product 0.450    expected weeks 0.950

Same teams, same product, and A is worth 0.4 of a week more, because a loss in
the first week forfeits everything downstream. Front-loading safety is correct
and the product cannot see it.

── The cost of front-loading, measured ─────────────────────────────────────

Expected weeks pulls toward spending the safest team *now*, because this
week's survival is the term with no discount on it. That is correct inside the
window and it has a real cost outside it: a horizon is about how far ahead an
estimate is trustworthy (about eight weeks) and not about how long the season
is, so anything still in the inventory when the window ends is valued at zero.
Front-loading against a truncated horizon burns the safe teams early, which is
the exact mechanism that makes plain greedy lose -- a handful of teams are the
best option in many weeks, and spending them first leaves nothing for week 12.

Replayed over 120 runs (ten seasons from twelve starting weeks) against the
product objective this replaced:

    product          4.75 weeks
    expected weeks   4.60 weeks      -0.15, standard error 0.11

Inside the noise, so not a demonstrated regression -- but the direction is not
noise: the share of runs where this strategy picked exactly what plain greedy
picked went from 69% to 74%. It moved toward greedy, as the mechanism predicts.

It is kept because it matches how the pot is actually paid out and the product
did not, and because the remedy is a known one rather than a hope: a terminal
value on the inventory left at the end of the window, which is what the shadow
-price future value in models/future_value.py is for. Re-measure after wiring
that in; if the loss does not come back, this pairing is wrong and the product
objective deserves another look.

── Why a beam search and not the exact DP ──────────────────────────────────

The pair above is also why the bitmask DP had to go. That DP kept one number
per (week, teams-used) state, which is sound for a product: any two paths
reaching the same state are interchangeable from there on. It is **not** sound
for expected weeks. The value of a continuation scales with the running
product, so a state has to be ranked on the pair (accumulated, product), and
the two above are the proof -- identical mask, identical product, different
accumulated. One scalar cannot order them.

Keeping the full Pareto frontier per state would be exact and much more
machinery. A beam search is the standard answer and the one the strategy
literature prescribes: carry the best `beam_width` partial plans by expected
weeks, deduplicated on (teams used, running product) so the beam does not fill
up with near-identical paths.

That makes the result **approximate**, which the product version was not, and
that is a real cost stated plainly. It buys an objective that matches how the
pot is actually paid out, which is worth more than exactness against the wrong
target.

── Why a bitmask DP, and why it is tractable ───────────────────────────────

Exhaustive over the whole league is 2^32 states and hopeless. Two prunes make
it small enough to be exact over what is left:

  * each week keeps only its ``per_week_top_k`` best teams -- a team outside a
    week's top six is not the pick that week under any plan, because every
    term is a win probability and a lower one cannot help;
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
about a team is wrong about them repeatedly. Nothing here models that, so both
numbers this returns are ranking devices rather than figures to quote. The
reasoning states them as a comparison between plans, never as "you have a 31%
chance of surviving to week 8".
"""
from __future__ import annotations

import math
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

# How many partial plans the beam carries. Wide enough that widening it further
# stops changing the answer on a real board, which is the only thing this
# number has to be. The search is over a universe of at most
# DEFAULT_MAX_CANDIDATE_TEAMS teams, so this is not the binding constraint --
# the pruning above is.
DEFAULT_BEAM_WIDTH = 2000

# Dedup resolution for the running product, as an integer so the two languages
# agree exactly. Python's round() and JavaScript's toFixed() disagree on
# halves, and a dedup key that differs between them would silently give the
# two engines different beams.
_PRODUCT_QUANTUM = 1_000_000_000


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
    expected_weeks: Optional[float] = None    # the objective: E[weeks survived]
    survival_pct: Optional[float] = None      # 0-100, the whole plan coming off
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


def solve(
    weekly_options: Dict[int, List[WeekPick]],
    beam_width: int = DEFAULT_BEAM_WIDTH,
) -> Tuple[float, float, List[WeekPick]]:
    """The all-distinct-teams sequence maximising expected weeks survived.

    Returns ``(expected_weeks, product, path)``. The product is carried along
    for display -- it is the chance the whole plan comes off -- but it is not
    what is being maximised. See the module docstring for why.

    A week with no options left is skipped rather than failing the search. That
    is the difference between "there is no plan" and "there is no plan that
    also covers week 12", and only the first is worth refusing: the traveler
    acts on step one either way.
    """
    ordered_weeks = sorted(weekly_options)
    universe = sorted({o.team_abbreviation for os in weekly_options.values() for o in os})
    index_of = {team: i for i, team in enumerate(universe)}

    # (expected_weeks, product, mask, path)
    beam: List[Tuple[float, float, int, List[WeekPick]]] = [(0.0, 1.0, 0, [])]
    advanced = False

    for week in ordered_weeks:
        options = weekly_options[week]
        if not options:
            continue

        candidates: List[Tuple[float, float, int, List[WeekPick]]] = []
        for expected, product, mask, path in beam:
            for option in options:
                bit = 1 << index_of[option.team_abbreviation]
                if mask & bit:
                    continue  # already spent earlier in this plan
                next_product = product * (option.win_pct / 100.0)
                candidates.append(
                    (expected + next_product, next_product, mask | bit, path + [option])
                )

        # Every candidate this week was already spent by every surviving plan.
        # Carry the plans forward rather than dropping them.
        if not candidates:
            continue

        # Dedup on (teams used, running product), keeping the best accumulated
        # value. Two plans that differ in neither are interchangeable from here
        # on, and without this the beam fills with near-identical paths and
        # stops exploring. Note the key keeps *different* products apart on
        # purpose -- that is exactly the pair the beam has to be able to rank.
        best_by_key: Dict[Tuple[int, int], Tuple[float, float, int, List[WeekPick]]] = {}
        for candidate in candidates:
            key = (candidate[2], math.floor(candidate[1] * _PRODUCT_QUANTUM))
            current = best_by_key.get(key)
            if current is None or candidate[0] > current[0]:
                best_by_key[key] = candidate

        ranked = sorted(
            best_by_key.values(),
            key=lambda c: (-c[0], "|".join(o.team_abbreviation for o in c[3])),
        )
        beam = ranked[:beam_width]
        advanced = True

    if not advanced:
        return 0.0, 0.0, []

    expected, product, _mask, path = beam[0]
    return expected, product, path


def _describe(option: WeekPick) -> str:
    basis = basis_phrase(option.win_pct_source)
    spread = f", spread {option.spread_detail}" if option.spread_detail else ""
    return (
        f"{option.team_abbreviation} vs {option.opponent_abbreviation or '?'} -- "
        f"{option.win_pct:.1f}% win prob{basis}{spread}"
    )


def _build_reasoning(
    pick: WeekPick,
    path: List[WeekPick],
    expected_weeks: float,
    product: float,
    universe: List[str],
) -> str:
    parts = [f"Top pick: {_describe(pick)}."]
    if len(path) > 1:
        plan = ", ".join(f"wk {p.week} {p.team_abbreviation}" for p in path[1:])
        parts.append(
            f"Chosen as the first step of the plan with the highest expected length "
            f"({plan}), searched over {len(universe)} candidate teams."
        )
        parts.append(
            f"That plan is worth about {expected_weeks:.1f} weeks of survival, with a "
            f"{product * 100:.1f}% chance of coming off in full -- both treating the weeks as "
            f"independent, so read them as a way of ranking plans against each other rather "
            f"than as figures to quote."
        )
        parts.append(
            "Expected length is what is maximised, not the chance of a clean run: the pot "
            "splits among whoever gets deepest, so a week of survival pays on its own."
        )
    else:
        parts.append(
            "Only this week had candidates, so no plan was searched and this is "
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
    beam_width: int = DEFAULT_BEAM_WIDTH,
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
    expected_weeks, product, path = solve(universe_options, beam_width)

    if not path or path[0].week != current_week:
        best = weekly[current_week][0]
        return SequenceRecommendation(
            week=current_week,
            pick=best,
            path=[best],
            expected_weeks=best.win_pct / 100.0,
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
        expected_weeks=expected_weeks,
        survival_pct=product * 100.0,
        candidate_universe=universe,
        reasoning=_build_reasoning(path[0], path, expected_weeks, product, universe),
    )
