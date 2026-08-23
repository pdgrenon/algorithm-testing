"""Expected pot share for one week, computed exactly.

This is the first thing here that optimises what the pool actually pays. Every
strategy before it maximised some flavour of "do not get knocked out", and the
harness showed what that is worth against 250 opponents: nothing. You win by
being right while others are wrong, and that is an arithmetic statement rather
than a slogan.

    EV(t) = p_t * E[ (N + E) / (E + K) | t wins ]

  N   opponents still alive
  E   your own entries still alive -- and you are in your own denominator
  K   how many opponents survive the week
  k_u how many opponents are on team u

Normalised by (N + E) so a pick that neither helps nor hurts scores 1.00.

── Why the underdog can be worth more, as arithmetic ───────────────────────

Two teams. A wins 70% and 85% of the field is on it; B wins 30% and 15% are::

    A:  0.70 * (1 / 0.85) = 0.82
    B:  0.30 * (1 / 0.15) = 2.00

The 30% underdog is worth 2.4 times the 70% favourite. Real slates compress
this hard -- nothing on an NFL board is 15% popular and 30% to win -- but the
mechanism is why contrarian picks have value at all. Raise A to 80% with
popularity unchanged and A becomes the clear best pick again. There is no rule
here, only the multiplication.

── Why this counts entries rather than binning a fraction ──────────────────

K is a sum of independent per-game contributions: game g adds k_home opponents
with probability p_home and k_away otherwise. That is a discrete convolution,
and the state is the number of survivors -- 0 to N, which is 251 values in this
pool. Exact, and small enough to be sub-millisecond.

It was written first over a fixed grid of 2,000 buckets across the *fraction*
surviving, and that was wrong in a way worth recording, because it looked
right. Rounding each side's share to the nearest bucket makes the convolution
compute a slightly different board than the one it was handed, so it disagreed
with brute-force enumeration by up to 2e-3 -- and refining the grid did not
reliably help, because the residuals are a deterministic walk rather than a
shrinking error: 20,000 buckets beat 200,000 on the worst board measured.

Counting entries removes the question rather than tuning it. **An entry is not
divisible**, so the number of opponents on a team is an integer, and once the
input has been apportioned to integers there is nothing left to round: the
convolution and the enumeration are computing over the same board and agree to
floating point. The grid is no longer a parameter, and there is no tolerance to
choose.

── What it cannot do ───────────────────────────────────────────────────────

It is myopic. It will happily burn the team that was going to carry Week 12 for
a hundredth of a point this week, because it has no idea Week 12 exists. Never
use it alone: pair it with the shadow price from models/future_value.py, or use
it as the rollout policy inside a search that does look ahead. The combined
score is `EV(t) - gamma * FV(t)`, and gamma has to be calibrated rather than
guessed, because the two terms are in different units.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class WeekGame:
    """One game, as this calculation needs it: two teams, a price, a following."""

    home: str
    away: str
    home_win_prob: float      # 0-1
    home_share: float         # fraction of surviving opponents on the home team
    away_share: float

    def side(self, team: str) -> Tuple[float, float]:
        """(win probability, opponent share) for one side."""
        if team == self.home:
            return self.home_win_prob, self.home_share
        if team == self.away:
            return 1.0 - self.home_win_prob, self.away_share
        raise ValueError(f"{team!r} is not in {self.away}@{self.home}")


@dataclass(frozen=True)
class PickEV:
    team: str
    win_prob: float
    opponent_share: float     # what fraction of the field is on this team
    ev: float                 # expected pot share, 1.00 = a neutral pick
    survivors_if_it_wins: float   # expected entries alive after the week


def apportion(shares: Sequence[float], total: int) -> List[int]:
    """Fractional shares to whole entries, preserving the total.

    Largest remainder, which is the standard way to hand out indivisible seats
    against fractional entitlements. The alternative -- rounding each share on
    its own -- loses the constraint that the parts add up, so a board of 16
    games could quietly describe 246 opponents or 254 rather than the 250 it
    was given.

    Ties in the remainder break on position so the result is deterministic;
    two teams with identical shares must not swap depending on dict order.
    """
    if total <= 0:
        return [0] * len(shares)
    exact = [s * total for s in shares]
    seats = [int(math.floor(x)) for x in exact]
    target = int(round(sum(exact)))
    gap = target - sum(seats)

    # The gap is never negative, and it is worth writing down why rather than
    # carrying a branch for it: sum(floor) is an integer no greater than
    # sum(exact), so sum(floor) <= floor(sum(exact)); and round(sum) is either
    # floor(sum) or floor(sum) + 1. The first draft handed back seats in an
    # `elif gap < 0`, which could not run -- the same dead-branch shape this
    # project has been caught by before, where a condition that reads like a
    # real case is one the arithmetic already excluded. Raising instead means
    # that if the proof is ever wrong it is loud rather than a silently
    # miscounted field.
    if gap < 0:  # pragma: no cover -- unreachable, see above
        raise AssertionError(f"apportionment went negative: {gap} on {total}")

    if gap:
        order = sorted(range(len(shares)), key=lambda i: (-(exact[i] - seats[i]), i))
        for i in order[:gap]:
            seats[i] += 1
    return seats


def _entry_counts(games: Sequence[WeekGame], opponents_alive: int) -> List[Tuple[int, int]]:
    """Every side of the board as a whole number of opponents.

    Apportioned across the board as a whole rather than game by game, because
    the constraint being preserved is that the field adds up to N.

    A board whose shares sum to less than 1 leaves the remainder unassigned,
    and unassigned opponents are treated as already out. That is only correct
    if you pass the whole slate -- which a real call does, since every
    surviving opponent has to pick some team that is playing.
    """
    flat = []
    for game in games:
        flat.append(game.home_share)
        flat.append(game.away_share)
    if sum(flat) > 1.0 + 1e-9:
        raise ValueError(
            f"popularity sums to {sum(flat):.4f}; a board cannot hold more than "
            "the whole field"
        )
    seats = apportion(flat, opponents_alive)
    return [(seats[2 * i], seats[2 * i + 1]) for i in range(len(games))]


def _survivor_distribution(
    games: Sequence[WeekGame],
    counts: Sequence[Tuple[int, int]],
    skip: int,
    opponents_alive: int,
) -> List[float]:
    """The exact distribution of surviving opponents, as mass over 0..N.

    Convolution, one game at a time. Every game contributes exactly one of two
    whole numbers, so nothing is rounded and the answer is exact.
    """
    dist = [0.0] * (opponents_alive + 1)
    dist[0] = 1.0
    top = 0

    for idx_game, game in enumerate(games):
        if idx_game == skip:
            continue
        home_seats, away_seats = counts[idx_game]
        nxt = [0.0] * (opponents_alive + 1)
        new_top = 0
        for idx in range(top + 1):
            mass = dist[idx]
            if mass == 0.0:
                continue
            for seats, prob in (
                (home_seats, game.home_win_prob),
                (away_seats, 1.0 - game.home_win_prob),
            ):
                if prob == 0.0:
                    continue
                target = min(opponents_alive, idx + seats)
                nxt[target] += mass * prob
                if target > new_top:
                    new_top = target
        dist = nxt
        top = new_top

    return dist[: top + 1]


def expected_pot_share(
    games: Sequence[WeekGame],
    team: str,
    opponents_alive: int,
    own_entries_alive: int = 1,
) -> PickEV:
    """One team's expected share of the pot, this week, exactly.

    Conditional on ``team`` winning -- a loss is worth nothing *this week* by
    construction, and the season-long correction to that (a loss can still tie
    for deepest under the deepest-splits rule) belongs to the search that calls
    this, not here.
    """
    own_index = next((i for i, g in enumerate(games) if team in (g.home, g.away)), None)
    if own_index is None:
        raise ValueError(f"{team!r} is not playing this week")

    own_game = games[own_index]
    win_prob, own_share = own_game.side(team)
    counts = _entry_counts(games, opponents_alive)
    # `team` is forced to win, so its own following survives with certainty and
    # is added rather than convolved.
    forced = counts[own_index][0] if team == own_game.home else counts[own_index][1]

    dist = _survivor_distribution(games, counts, own_index, opponents_alive)

    total = opponents_alive + own_entries_alive
    ev = 0.0
    expected_survivors = 0.0
    for survivors, mass in enumerate(dist):
        if mass == 0.0:
            continue
        alive = own_entries_alive + min(opponents_alive, survivors + forced)
        ev += mass * (total / alive)
        expected_survivors += mass * alive

    return PickEV(
        team=team,
        win_prob=win_prob,
        opponent_share=own_share,
        ev=win_prob * ev,
        survivors_if_it_wins=expected_survivors,
    )


def rank_by_pot_share(
    games: Sequence[WeekGame],
    candidates: Sequence[str],
    opponents_alive: int,
    own_entries_alive: int = 1,
) -> List[PickEV]:
    """Every candidate scored and ordered, best first.

    Ties break on the team name so the ordering is stable -- a board where two
    teams score identically is common once popularity is rounded to whole
    entries, and an unstable sort there makes the recommendation depend on
    dictionary order.
    """
    scored = [
        expected_pot_share(games, team, opponents_alive, own_entries_alive)
        for team in candidates
    ]
    scored.sort(key=lambda s: (-s.ev, s.team))
    return scored


def enumerate_pot_share(
    games: Sequence[WeekGame],
    team: str,
    opponents_alive: int,
    own_entries_alive: int = 1,
) -> float:
    """The same number by brute force over every outcome, as a test oracle.

    2^G outcomes, so this is unusable above about 20 games and exact below it.
    It exists to prove the convolution rather than to be called: if these two
    ever disagree, the convolution is wrong and the fast path is quietly
    mis-scoring every pick.

    It apportions the board the same way, so the two are computing over the
    same integers and must agree to floating point rather than to a tolerance.
    """
    own_index = next((i for i, g in enumerate(games) if team in (g.home, g.away)), None)
    if own_index is None:
        raise ValueError(f"{team!r} is not playing this week")
    own_game = games[own_index]
    win_prob, _ = own_game.side(team)
    counts = _entry_counts(games, opponents_alive)
    forced = counts[own_index][0] if team == own_game.home else counts[own_index][1]

    others = [(g, counts[i]) for i, g in enumerate(games) if i != own_index]
    total = opponents_alive + own_entries_alive
    ev = 0.0
    for mask in range(1 << len(others)):
        prob = 1.0
        survivors = forced
        for i, (game, (home_seats, away_seats)) in enumerate(others):
            if mask >> i & 1:
                prob *= game.home_win_prob
                survivors += home_seats
            else:
                prob *= 1.0 - game.home_win_prob
                survivors += away_seats
        if prob == 0.0:
            continue
        alive = own_entries_alive + min(opponents_alive, survivors)
        ev += prob * (total / alive)
    return win_prob * ev
