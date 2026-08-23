"""Expected pot share for a holding of several entries, computed exactly.

Two entries are not two separate problems, and the reason is one line of
arithmetic: **they split the same pot**.

    EV = (N + E) / E * E[ A / (A + K) ]

  N   opponents you will be splitting with
  E   your entries still alive
  A   how many of your entries survive
  K   how many opponents survive

Normalised so that a holding which neither helps nor hurts scores 1.00, on the
same scale as models/pot_share_ev.py -- and at E=1 this *is* that function, to
floating point. There is a test.

── N is the field you finish against, not the field you start against ──────

This is the whole of how to use it, and it was got wrong first. The docstring
here originally claimed the model prefers to spread the two entries across
different games, as an argument from convexity. Measured on a ten-game board
against 250 opponents, it does the opposite and it is not close: both entries
on the same favourite scores 1.1099 against 1.0949 for the best split pair, and
doubling up stays ahead all the way down to about five opponents.

That is not a flaw in the model, it is the wrong N. Against 250 opponents your
two entries are 0.8% of the denominator, so a second survivor really is worth
very nearly a second full share and the arithmetic says take it. What makes
diversification pay is the *terminal* field, and under deepest-splits that
field is tiny -- ``expected_perfect_entries()`` is 0.87 out of 250. Measured on
the settlement function itself, with the field's best week at 11:

    my entries at 11 and 11, field at 11  ->  0.00800 of the pot
    my entries at 12 and 11, field at 11  ->  1.00000
    my entries at 12 and 12, field at 11  ->  1.00000

**Once either entry is clear of the field, the second one is worth exactly
zero.** 2/(2+0) and 1/(1+0) are both the whole pot. So what you are really
buying is the probability that the *better* of your two entries beats the
field, which is a max-statistic, and max-statistics reward anti-correlation.

Pass N accordingly. For "what is this week worth", pass the opponents alive
now. For "which pair should I take", pass the field you expect to be splitting
with at the end -- about one for this pool -- and the same function that
preferred KC/KC at N=250 now ranks it eighth:

    against N=1:   BUF/KC  0.9800   P(at least one alive) 0.9760
                   KC/KC   0.8800   P(at least one alive) 0.8800

No new machinery, and no rule of thumb about diversifying: the crossover is
read off the board, and on a slate with one overwhelming favourite and nothing
else behind it, doubling up is correct and this says so.

── Measured, and it does not beat forcing the two entries apart ────────────

Over 2,000 synthetic seasons this model ranks *below* the simplest thing you
can do with two entries -- run one strategy twice and strike the first
entry's pick from the second's inventory:

    distinct   1.95x fair   reaches Week 6.58
    potshare   1.56x fair   reaches Week 5.85    loses 76 seasons to 45

It trades depth for being uncrowded and does not earn it back. Against two
identical entries it no longer separates at all (t = 1.01), having looked
decisive at 400 seasons (t = 2.99) -- see the note in scripts/backtest.py on
why 400 was not enough, because that is the more useful lesson.

The arithmetic below is not what failed; it agrees with brute-force
enumeration to 1e-12 and every property test holds. What failed is the policy
built on it, and the most likely cause is named in the robustness grid: told
the field is *more* spread out than it truly is, this model scores better than
told the truth, which says the contrarian tilt is too strong. `terminal_field`
projecting to one opponent from Week 1 is as contrarian as it can be, and is
the first thing to try differently.

Kept, because the model is correct and reusable -- as a rollout policy inside
a search, or with a calibrated tilt -- and because a measurement that says
"this does not work" is worth more written down than deleted.

── What it cannot see: which entry takes which team ────────────────────────

The one-week EV is **exactly symmetric** in your entries -- KC/BUF and BUF/KC
score to the last bit, because the calculation only asks how many of your
entries survive and never which. So `rank_holdings` breaks that tie
alphabetically, and the choice is arbitrary.

It is not a tie in the season. The two assignments leave your entries holding
different inventories, which decides what each can pick for the remaining
seventeen weeks. Traced through one simulated season, two strategies made the
identical pair of picks in Weeks 1 and 2 and came out with survivors carrying
{LAR, MIA} and {IND, MIA} -- a divergence produced entirely by the tiebreak,
and one that then chose different teams every week after.

There is no myopic fix, which is why this is written down rather than
patched: the assignment matters only through the future, so distinguishing
the two orderings requires the lookahead this module deliberately does not
have. Pair it with the shadow price from models/future_value.py and the
question becomes answerable. Until then, do not "fix" the ordering -- there
is a test asserting the symmetry, because an ordering that looks meaningful
is exactly the thing somebody optimises next.

── Correlation is handled by enumeration, not assumed away ─────────────────

The optimiser this replaces required the two picks to be in different games so
that independence held by construction, forbade both entries taking the same
team, and imposed a 65% win-probability floor on the second entry. All three
are unmeasured rules, and the first two rule out answers that are sometimes
right.

Nothing here assumes independence. Your picks' games are enumerated exactly
(2^m for the m distinct games you hold a pick in, which is at most E), and only
the games you have no stake in are convolved. Opposing sides of one game, both
entries on one team, and two unrelated games are all just outcomes, and the
arithmetic does not change shape between them. On the board above, opposite
sides of one game -- a guaranteed single survivor -- ranks 193rd of 400 rather
than being unavailable, which is the honest treatment of a hedge that costs
too much here and would not on a board with no good second pick.
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from typing import Dict, FrozenSet, List, Optional, Sequence, Tuple

from models.pot_share_ev import WeekGame, _entry_counts, _survivor_distribution


@dataclass(frozen=True)
class HoldingEV:
    teams: Tuple[str, ...]        # one team per entry, in entry order
    ev: float                     # multiple of fair for the whole holding
    survival: Tuple[float, ...]   # P(exactly 0 survive), P(exactly 1), ...
    expected_entries: float       # how many of your entries live, on average


def _distribution_excluding(
    games: Sequence[WeekGame],
    counts: Sequence[Tuple[int, int]],
    excluded: FrozenSet[int],
    opponents_alive: int,
    cache: Optional[Dict[FrozenSet[int], List[float]]] = None,
) -> List[float]:
    """Opponents surviving among the games you hold no stake in."""
    if cache is not None and excluded in cache:
        return cache[excluded]
    dist = [0.0] * (opponents_alive + 1)
    dist[0] = 1.0
    top = 0
    for idx, game in enumerate(games):
        if idx in excluded:
            continue
        home_seats, away_seats = counts[idx]
        nxt = [0.0] * (opponents_alive + 1)
        new_top = 0
        for k in range(top + 1):
            mass = dist[k]
            if mass == 0.0:
                continue
            for seats, prob in (
                (home_seats, game.home_win_prob),
                (away_seats, 1.0 - game.home_win_prob),
            ):
                if prob == 0.0:
                    continue
                target = min(opponents_alive, k + seats)
                nxt[target] += mass * prob
                if target > new_top:
                    new_top = target
        dist = nxt
        top = new_top
    result = dist[: top + 1]
    if cache is not None:
        cache[excluded] = result
    return result


def expected_pot_share_holding(
    games: Sequence[WeekGame],
    teams: Sequence[str],
    opponents_alive: int,
    _counts: Optional[Sequence[Tuple[int, int]]] = None,
    _cache: Optional[Dict[FrozenSet[int], List[float]]] = None,
) -> HoldingEV:
    """What a whole holding is worth this week, exactly.

    ``teams`` is one pick per entry, in entry order. Repeats are allowed and
    are scored rather than refused -- whether doubling up is a mistake is a
    property of the board, and this is the thing that decides it.
    """
    if not teams:
        raise ValueError("a holding needs at least one entry")

    counts = list(_entry_counts(games, opponents_alive)) if _counts is None else list(_counts)

    # Which game each entry has a stake in, and which side of it.
    stakes: List[Tuple[int, bool]] = []
    for team in teams:
        for idx, game in enumerate(games):
            if team == game.home:
                stakes.append((idx, True))
                break
            if team == game.away:
                stakes.append((idx, False))
                break
        else:
            raise ValueError(f"{team!r} is not playing this week")

    mine = sorted({idx for idx, _ in stakes})
    rest = _distribution_excluding(
        games, counts, frozenset(mine), opponents_alive, _cache
    )

    entries = len(teams)
    total = opponents_alive + entries
    ev = 0.0
    survival = [0.0] * (entries + 1)

    # Every outcome of the games you hold a stake in, exactly. At most 2^E.
    for outcome in product((True, False), repeat=len(mine)):
        home_wins = dict(zip(mine, outcome))
        prob = 1.0
        for idx, home in home_wins.items():
            p = games[idx].home_win_prob
            prob *= p if home else 1.0 - p
        if prob == 0.0:
            continue

        alive_entries = sum(1 for idx, is_home in stakes if home_wins[idx] == is_home)
        survival[alive_entries] += prob
        if alive_entries == 0:
            continue

        forced = sum(
            counts[idx][0] if home else counts[idx][1] for idx, home in home_wins.items()
        )
        share = 0.0
        for survivors, mass in enumerate(rest):
            if mass == 0.0:
                continue
            opponents = min(opponents_alive, survivors + forced)
            share += mass * (alive_entries / (alive_entries + opponents))
        ev += prob * share

    return HoldingEV(
        teams=tuple(teams),
        ev=ev * total / entries,
        survival=tuple(survival),
        expected_entries=sum(i * p for i, p in enumerate(survival)),
    )


def rank_holdings(
    games: Sequence[WeekGame],
    inventories: Sequence[Sequence[str]],
    opponents_alive: int,
    limit: Optional[int] = None,
) -> List[HoldingEV]:
    """Every legal combination of picks across your entries, best first.

    ``inventories`` is what each entry may still pick, in entry order. The
    search is the product of those, which for two entries on a full slate is
    about a thousand combinations -- small enough to enumerate rather than
    approximate, and the reason there is no beam here.

    Ties break on the teams so the order does not depend on dict order.
    """
    counts = _entry_counts(games, opponents_alive)
    cache: Dict[FrozenSet[int], List[float]] = {}
    scored = [
        expected_pot_share_holding(games, combo, opponents_alive, counts, cache)
        for combo in product(*inventories)
    ]
    scored.sort(key=lambda h: (-h.ev, h.teams))
    return scored[:limit] if limit else scored
