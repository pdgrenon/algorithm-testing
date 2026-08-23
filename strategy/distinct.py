"""Both entries from one strategy, forbidden from landing on the same team.

The simplest thing you can do with two entries, and the one the harness
measured at the top of every run: pick for each entry, and if the second wants
the team the first took, pick again with that team struck off. Nothing else
changes.

── Why this exists next to joint_optimizer ─────────────────────────────────

`joint_optimizer` searches every legal pair at once under three hard
constraints -- different games, never the same team, and a floor on Entry B's
win probability -- and 2,500 simulated seasons could not tell the two apart:
t = 0.73 on the paired difference, 94 seasons to 73. A dead heat.

Nor could they separate either of those from `entry_b_hedge` run behind
`entry_a_value`, which is the greedy version of the same idea: 1.72, 1.62 and
1.56 times a fair share, at t = 0.83 and 0.29. What all three share is that
they never put the two entries on one team, and *that* is what separates them
from the other three -- 0.98, 0.91 and 0.74, colliding in 100% of weeks, and
every crossing between the groups significant at t from 2.92 to 5.36. The
choice of algorithm is a coin toss; the constraint is worth two weeks of
survival.

That is a measurement against a *simulated* field whose concentration is a
prior rather than an observation. Once real pick data arrives that prior can be
fitted (see `fit_tau` in scripts/field.py), and a comparison that came out
level under an assumed field is not guaranteed to stay level under a measured
one. So both are offered rather than one being retired on today's numbers.

They also differ in a way the tie hides. `joint`'s constraints make some
holdings unreachable -- it cannot put the two entries on opposite sides of one
game, which is the hedge that becomes decisive against a field concentrated on
a single team. This has no constraint beyond the one in its name, so its
behaviour is whatever the underlying strategy does, twice, minus a collision.

── Unconstrained first, and only then the exclusion ────────────────────────

Each entry is asked what it wants on its own, and the exclusion is applied only
where two entries actually want the same team. That is not an optimisation for
its own sake: it means `collided` can be reported truthfully -- whether the
constraint bound at all this week -- and a week where it did not is a week this
is identical to running the underlying strategy twice. Saying so is worth more
than hiding it, because the user's question is exactly whether these differ.

The cost follows the same shape: two searches when the entries disagree, three
when they collide.

── The order is fixed rather than searched, and that is arbitrary ──────────

The first entry keeps its pick and the second works around it. The other
ordering is a different holding, and choosing between them needs a lookahead
this does not have -- the same open question as the symmetry note in
models/joint_pot_share.py, left open here for the same reason. What it is not
is unstable: the order is the entry order, so the same inputs give the same
answer every time.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from data.models import Game
from models.win_prob import TeamWeekWinProbability
from strategy import sequence_dp

ENTRY_A_NAME = "Entry A"
ENTRY_B_NAME = "Entry B"


@dataclass
class DistinctRecommendation:
    """One pick per entry, and whether the no-collision rule actually bound."""

    week: int
    picks: Dict[str, Optional[sequence_dp.WeekPick]] = field(default_factory=dict)
    reasoning: Dict[str, str] = field(default_factory=dict)
    collided: List[str] = field(default_factory=list)   # entries that had to move


def recommend(
    current_week_games: Sequence[Game],
    win_prob_table: Dict[Tuple[str, int], TeamWeekWinProbability],
    current_week: int,
    used_teams_by_entry: Optional[Dict[str, List[str]]] = None,
    entry_order: Sequence[str] = (ENTRY_A_NAME, ENTRY_B_NAME),
    **options,
) -> DistinctRecommendation:
    """Each entry's own best pick, with collisions resolved in entry order.

    ``options`` passes through to ``sequence_dp.recommend`` unchanged, so the
    lookahead and search-width settings are the ones that strategy documents.
    """
    used_by_entry = dict(used_teams_by_entry or {})
    out = DistinctRecommendation(week=current_week)
    taken: List[str] = []

    for entry in entry_order:
        used = list(used_by_entry.get(entry, []))
        rec = sequence_dp.recommend(
            current_week_games, win_prob_table, current_week, used_teams=used, **options
        )
        if rec.pick is not None and rec.pick.team_abbreviation in taken:
            out.collided.append(entry)
            rec = sequence_dp.recommend(
                current_week_games, win_prob_table, current_week,
                used_teams=used + taken, **options,
            )
        out.picks[entry] = rec.pick
        out.reasoning[entry] = rec.reasoning
        if rec.pick is not None:
            if rec.pick.team_abbreviation in taken:
                # Unreachable: it was excluded above. Asserted rather than
                # assumed, because a silent collision is the single failure
                # this strategy exists to prevent and nothing downstream
                # would notice one.
                raise AssertionError(
                    f"{entry} was given {rec.pick.team_abbreviation}, already taken this week"
                )
            taken.append(rec.pick.team_abbreviation)

    return out
