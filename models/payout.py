"""What a finished season is worth, which is not the same as surviving it.

Every strategy in this repository has optimised some flavour of "do not get
knocked out". That is the wrong objective, and the pool's payout rule is where
the difference becomes concrete.

── The rule this pool actually uses ────────────────────────────────────────

250 entries, $10 each, and the pot splits equally among everyone still alive
after Week 18. So the clean terminal function is::

    payoff = 1 / n_survivors   if you survived all 18 weeks
           = 0                 otherwise

**And that function is undefined in the single most likely outcome.** At the
historical public survival rate of about 73% a week, the expected number of
entries going a perfect 18-0 out of 250 is ``250 * 0.73**18``, which is 0.87 --
less than one. Treating the weeks as independent puts the chance that *nobody*
survives at around 42%, and the real figure is higher still, because pool picks
are heavily correlated: the field piles onto the same favourites and entries
die in clumps rather than one at a time.

So the rule that decides roughly half of all seasons is the one that never gets
written down: what happens when everybody is eliminated. Nearly every pool
resolves it the same way and this one is confirmed to -- **the deepest
survivors split**::

    D       = the furthest week any entry reached
    winners = every entry that reached D
    payoff  = 1 / |winners|   if you are one of them, else 0

Note this subsumes the clean version rather than replacing it: if somebody does
go 18-0 then D is 18 and only the perfect entries are winners.

── Two consequences that change how the engine should behave ───────────────

**Depth pays directly.** Under a strict "must go 18-0" reading, an extra week
of survival is worth nothing unless it reaches the end, and expected longevity
is a pointless objective. Under deepest-splits, surviving to Week 12 when the
rest of the field died in Week 11 wins the entire pot. Longevity is still not
*the* objective -- what pays is depth relative to the field, not absolute depth
-- but it stops being a bad proxy and becomes a decent one.

**A loss is no longer worth zero.** This is the one that is easy to get wrong
in a simulator. Your pick can lose and you can still be tied for deepest, if
the rest of the field dies the same week. Any variance-reduction trick that
assumes "we lost, therefore the payoff is 0, therefore skip the branch" is
unsound here, and it biases toward safety exactly when the loss branch is worth
the most.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, Mapping, Optional, Sequence

# The confirmed configuration for this pool. Named here rather than passed
# around as loose numbers, because the field size is what decides how far you
# have to get and therefore how much future value is worth.
DEFAULT_POOL_SIZE = 250
DEFAULT_BUY_IN = 10.0
FINAL_WEEK = 18

# Historical public survival rate, per week. Only used to describe the pool's
# shape (see `expected_perfect_entries`), never to score a pick.
PUBLIC_WEEKLY_SURVIVAL = 0.73


@dataclass(frozen=True)
class Payout:
    """One entry's outcome at the end of a simulated season."""

    depth: int                 # the furthest week any entry reached
    winners: int               # how many entries reached it
    share: float               # this entry's share of the pot, 0 to 1
    went_the_distance: bool    # whether `depth` is the final week


def expected_perfect_entries(
    pool_size: int = DEFAULT_POOL_SIZE,
    weekly_survival: float = PUBLIC_WEEKLY_SURVIVAL,
    weeks: int = FINAL_WEEK,
) -> float:
    """How many entries a pool this size should expect to finish unbeaten.

    Below 1 is the regime where the deepest-splits rule is not an edge case but
    the normal ending. At 250 entries and the public rate it comes out at 0.87.
    """
    return pool_size * (weekly_survival ** weeks)


def settle(
    last_week_survived: Mapping[str, int],
    entry_ids: Optional[Iterable[str]] = None,
    final_week: int = FINAL_WEEK,
) -> Dict[str, Payout]:
    """Split the pot among the entries that got deepest.

    ``last_week_survived`` maps every entry in the pool -- yours and the field
    alike -- to the last week its pick won. An entry eliminated in week 5 has
    survived 4. An entry that never picked has 0.

    Returns a payout for every entry, so a caller can read its own share
    without knowing how the rest of the field did.

    The shares always sum to 1: this never returns zero for everybody, which is
    what makes it usable as a simulation terminal. A simulator whose payoff can
    be zero on every path is wasting those paths.
    """
    ids = list(entry_ids) if entry_ids is not None else list(last_week_survived)
    if not ids:
        return {}

    depth = max(last_week_survived.get(e, 0) for e in ids)
    winners = [e for e in ids if last_week_survived.get(e, 0) == depth]
    share = 1.0 / len(winners) if winners else 0.0
    went = depth >= final_week

    return {
        e: Payout(
            depth=depth,
            winners=len(winners),
            share=share if e in set(winners) else 0.0,
            went_the_distance=went,
        )
        for e in ids
    }


def pot_share(
    last_week_survived: Mapping[str, int],
    my_entries: Sequence[str],
    entry_ids: Optional[Iterable[str]] = None,
    final_week: int = FINAL_WEEK,
) -> float:
    """The fraction of the pot *you* take, across however many entries you hold.

    Two entries are two claims on the same pot, so their shares add -- and the
    denominator counts them both. That is easy to get wrong in two different
    directions at once: forgetting your own entries are in the field at all, or
    counting them once when you hold two.
    """
    settled = settle(last_week_survived, entry_ids, final_week)
    return sum(settled[e].share for e in my_entries if e in settled)


def value_of(share: float, pool_size: int = DEFAULT_POOL_SIZE, buy_in: float = DEFAULT_BUY_IN) -> float:
    """A pot share in money, for reporting. The pot is pool_size * buy_in."""
    return share * pool_size * buy_in


def fair_share(pool_size: int = DEFAULT_POOL_SIZE) -> float:
    """What one entry is worth playing at random -- the number to beat.

    A pot share of 1/250 on a $10 buy-in is exactly $10 back on $10 staked. Any
    report of the engine's value should be read against this and not against
    whether it won, because it will not win most years.
    """
    return 1.0 / pool_size
