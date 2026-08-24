"""Replay whole seasons against real results, and say how long each strategy lasted.

Nothing else here can tell you whether a change to the engine is an
improvement. The golden fixtures prove the JavaScript port matches the Python;
they say nothing about whether either is any good, because the fixture season
is synthetic and has no results in it. So every decision about the scoring so
far has been an argument. This is the thing that settles one.

    python3 scripts/backtest.py                       # every strategy, 2015-2024
    python3 scripts/backtest.py --seasons 2020 2021
    python3 scripts/backtest.py --compare-win-prob --starts 8   # before vs after
    python3 scripts/backtest.py --refresh             # re-download the results

── Why this is a script and not a test ─────────────────────────────────────

It fetches. `scripts/no-network.mjs` exists because a test that reaches the
network passes on a laptop with no internet (call fails, falls back, assertion
still holds) and then fails in CI where it succeeds — and that has cost a red
build here already. So this lives beside the other authoring tools, is never
imported by the suite, and holds its download in `cache/` like the ESPN client
holds its own.

── Where the results come from ─────────────────────────────────────────────

nflverse's `games.csv`, which is the file behind nflreadr's `load_schedules()`.
One row per game since 1999 with the closing line, both moneylines and the
final score. ESPN is not usable for this: its endpoints are per-event and
undocumented, and pulling twenty seasons out of them one game at a time is
exactly the request volume `data/espn_client.py` is written to avoid.

The rows are adapted into the same `Game` objects `data/espn_client.py`
produces, so the engine under test is the real one — `models/win_prob.py` and
the strategies, unmodified and unaware they are being replayed. What the
adapter cannot supply is ESPN's own published probability, which does not exist
historically. That is not a gap in the harness so much as the point of it: what
gets exercised is the moneyline rung and the spread rung, which is where the
scoring decisions actually live.

── What "survived" means ───────────────────────────────────────────────────

One entry, one pick a week, no team twice, eliminated the first week the pick
loses. A tie counts as a win, which matches this pool's rule. The number reported
is how many weeks the entry lasted, which is the only thing a survivor pool
scores on — not accuracy, not Brier, not how confident the pick was.

── What it said the first time it was run ──────────────────────────────────

Recorded because it is the kind of result that gets misremembered as better
than it was. Comparing the engine before the win-probability work against the
engine after it, paired over 80 runs (ten seasons from eight starting weeks
each):

    ranked   4.67 -> 4.86   +0.19    std err 0.19
    value    4.59 -> 4.91   +0.33    std err 0.20
    hedge    4.67 -> 4.86   +0.19    std err 0.19
    joint    3.54 -> 3.84   +0.30    std err 0.18

Every strategy improved, and **not one of them is outside two standard errors**.
Four out of four moving the same way is worth something, but the honest reading
is that the effect on weeks survived is small and this sample cannot separate
it from luck. A survivor season is one entry making at most eighteen decisions;
the variance swamps almost anything the scoring does.

That is not an argument against the change. Being right about the numbers is
worth doing on its own — the app *shows* them, and a 10-point favourite drawn
at 62% when the real figure is 85% is a lie on screen whether or not it moves
the pick. It is an argument against claiming a measured edge, and a reason to
run this with more than a handful of seasons before believing the next one.

A second thing it settled: the spread curve is nearly unreachable on real data.
Books post moneylines on essentially every modern NFL game, so the moneyline
rung takes precedence — across 2015-2024 the spread estimate fires twice in
5,246 team-weeks. Comparing only the spread curve, as the first version of
`--compare-win-prob` did, therefore showed no difference at all, because it was
measuring a path that never runs.
"""
from __future__ import annotations

import argparse
import csv
import inspect
import multiprocessing
import os
import random
import sys
import urllib.request
from pathlib import Path
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, List, Optional, Set, Tuple

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from data.models import Game, Odds, Team  # noqa: E402
from models.win_prob import (  # noqa: E402
    build_win_probability_table,
    resolve_team_win_probability,
)
from picker import recommender  # noqa: E402
from models.joint_pot_share import rank_holdings  # noqa: E402
from models.pot_share_ev import WeekGame  # noqa: E402
from models.payout import DEFAULT_POOL_SIZE, fair_share, pot_share  # noqa: E402
from scripts import field as field_model  # noqa: E402
from scripts import synth  # noqa: E402
from strategy import entry_a_value, entry_b_hedge, joint_optimizer, leverage, sequence_dp  # noqa: E402

GAMES_CSV_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
CACHE = ROOT / "cache" / "nflverse-games.csv"
REGULAR_SEASON = "REG"


# -- results ---------------------------------------------------------------

def load_rows(refresh: bool = False) -> List[dict]:
    """nflverse's games.csv, from `cache/` unless asked to re-download.

    Cached indefinitely rather than on a TTL: completed seasons never change,
    and the only reason to refresh is to pick up a season that has since
    finished. `--refresh` is that reason, stated explicitly.
    """
    if refresh or not CACHE.exists():
        print(f"downloading {GAMES_CSV_URL} ...", file=sys.stderr)
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(
            GAMES_CSV_URL, headers={"User-Agent": "deadpool-backtest/0.1 (personal use)"}
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            CACHE.write_bytes(response.read())
        print(f"cached to {CACHE.relative_to(ROOT)}", file=sys.stderr)

    with CACHE.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def _number(value: str) -> Optional[float]:
    """A CSV cell as a float, or None. Empty means "not published", never zero."""
    if value is None or value == "" or value == "NA":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def games_for_season(rows: Iterable[dict], season: int) -> Dict[int, List[Game]]:
    """One season's regular-season games, by week, in the engine's own shape.

    The two sign conventions are the whole of the translation and the easiest
    thing here to get backwards. nflverse's ``spread_line`` is positive when
    the home team is favoured; ESPN's ``spread``, which `models/win_prob.py`
    reads, is negative. Moneylines need no conversion — American odds are
    American odds.
    """
    by_week: Dict[int, List[Game]] = {}
    for row in rows:
        if int(row["season"]) != season or row.get("game_type") != REGULAR_SEASON:
            continue

        week = int(row["week"])
        spread_line = _number(row.get("spread_line"))
        home_ml = _number(row.get("home_moneyline"))
        away_ml = _number(row.get("away_moneyline"))

        by_week.setdefault(week, []).append(
            Game(
                event_id=row["game_id"],
                competition_id=row["game_id"],
                week=week,
                season_year=season,
                state="pre",  # replayed as it stood before kickoff
                home=Team(abbreviation=row["home_team"], display_name=row["home_team"]),
                away=Team(abbreviation=row["away_team"], display_name=row["away_team"]),
                probability=None,  # ESPN publishes no history; see the module docstring
                odds=Odds(
                    spread=None if spread_line is None else -spread_line,
                    home_moneyline=home_ml,
                    away_moneyline=away_ml,
                ),
            )
        )
    return by_week


def outcome_for(rows: Iterable[dict], season: int) -> Dict[Tuple[int, str], str]:
    """{(week, team): "win" | "loss"} for every completed regular-season game.

    A tie is a win. Note this was already true here while the app's own
    default said the opposite -- the two are agreed now, but the harness was
    the one that happened to be right. A game with no final score is
    absent, which is how an in-progress season stops the replay rather than
    silently scoring a pick against nothing.
    """
    out: Dict[Tuple[int, str], str] = {}
    for row in rows:
        if int(row["season"]) != season or row.get("game_type") != REGULAR_SEASON:
            continue
        result = _number(row.get("result"))
        if result is None:
            continue
        week = int(row["week"])
        home_won = result >= 0          # a tie counts for both sides
        away_won = result <= 0
        out[(week, row["home_team"])] = "win" if home_won else "loss"
        out[(week, row["away_team"])] = "win" if away_won else "loss"
    return out


# -- the strategies, as one signature --------------------------------------
#
# Each takes (games this week, season table, week, used teams) and returns a
# team abbreviation or None. The engine's own functions are called unmodified;
# these are adapters, not reimplementations.

def pick_ranked(games, table, week, used) -> Optional[str]:
    ranked = recommender.rank_candidates(games, used)
    return ranked[0].team_abbreviation if ranked else None


def pick_value(games, table, week, used) -> Optional[str]:
    rec = entry_a_value.recommend(games, table, week, used_teams=used)
    return rec.pick.team_abbreviation if rec.pick else None


def pick_hedge(games, table, week, used) -> Optional[str]:
    # No Entry A to hedge against in a single-entry replay, so this is the
    # floor rule on its own — which is the half of it worth measuring.
    rec = entry_b_hedge.recommend(games, week, used_teams=used)
    return rec.pick.team_abbreviation if rec.pick else None


def pick_joint(games, table, week, used) -> Optional[str]:
    # The pair search with the second entry given nothing used, so what is
    # measured is the team it puts Entry A on.
    rec = joint_optimizer.recommend(games, week, used_teams_a=used, used_teams_b=[])
    return rec.pick_a.team_abbreviation if rec.pick_a else None


def pick_sequence(games, table, week, used) -> Optional[str]:
    rec = sequence_dp.recommend(games, table, week, used_teams=used)
    return rec.pick.team_abbreviation if rec.pick else None


STRATEGIES: Dict[str, Callable] = {
    "sequence": pick_sequence,
    "ranked": pick_ranked,
    "value": pick_value,
    "hedge": pick_hedge,
    "joint": pick_joint,
}


# -- the replay ------------------------------------------------------------

def simulate(
    by_week: Dict[int, List[Game]],
    outcomes: Dict[Tuple[int, str], str],
    pick_for: Callable,
    start_week: int = 1,
) -> Tuple[int, Optional[str], List[Tuple[int, str, str]]]:
    """Run one entry through a season. Returns (weeks survived, how it ended, log).

    The whole season's table is built once and handed in every week, which is
    what the app does and what makes the lookahead mean anything. Note the
    deliberate cheat this does *not* commit: the table carries lines for future
    weeks, which a real Wednesday would not have, but it carries no results —
    so a strategy can look ahead at what the market expects and never at what
    happened.
    """
    table = build_win_probability_table([g for w in sorted(by_week) for g in by_week[w]])
    used: List[str] = []
    log: List[Tuple[int, str, str]] = []

    for week in sorted(w for w in by_week if w >= start_week):
        team = pick_for(by_week[week], table, week, used)
        if team is None:
            return len(log), "ran out of teams", log

        result = outcomes.get((week, team))
        if result is None:
            return len(log), "season incomplete", log

        log.append((week, team, result))
        used.append(team)
        if result == "loss":
            return len(log), f"eliminated in week {week} on {team}", log

    return len(log), "survived the season", log


def simulate_pot_share(
    by_week: Dict[int, List[Game]],
    outcomes: Dict[Tuple[int, str], str],
    pick_for: Callable,
    seed: int,
    start_week: int = 1,
    pool_size: int = DEFAULT_POOL_SIZE,
    tau: float = field_model.CASUAL_TAU,
) -> float:
    """Run one season against a whole simulated field and return your pot share.

    This is the metric the pool actually pays on. Weeks survived says how long
    you lasted; this says how long you lasted *relative to the field*, which is
    a different number and occasionally the opposite one -- reaching Week 12
    takes the lot if everybody else died in Week 11, and takes nothing if half
    of them reached Week 14.

    One entry of yours, so the field is you plus `pool_size - 1` opponents.
    Common random numbers: the seed drives the opponents only, so the same seed
    across two strategies gives them the same field to beat rather than two
    different ones. Game outcomes are historical and identical either way.
    """
    table = build_win_probability_table([g for w in sorted(by_week) for g in by_week[w]])
    rng = random.Random(seed)

    me = "me"
    pool = field_model.build_field(pool_size, [me])
    my_used: List[str] = []

    for week in sorted(w for w in by_week if w >= start_week):
        candidates = []
        for game in by_week[week]:
            for is_home in (True, False):
                resolved = resolve_team_win_probability(game, is_home)
                if resolved.win_pct is not None and resolved.team_abbreviation:
                    candidates.append((resolved.team_abbreviation, resolved.win_pct))
        candidates.sort(key=lambda c: (-c[1], c[0]))
        if not candidates:
            break

        # You, from the strategy under test.
        entry = pool[me]
        if entry.alive:
            team = pick_for(by_week[week], table, week, my_used)
            if team is None:
                entry.alive = False
            else:
                my_used.append(team)
                entry.used.add(team)
                result = outcomes.get((week, team))
                if result == "win":
                    entry.last_week_survived = week
                else:
                    entry.alive = False

        # The field.
        for opponent_id, opponent in pool.items():
            if opponent_id == me:
                continue
            field_model.advance(opponent, candidates, outcomes, week, rng, tau)

        if not any(o.alive for o in pool.values()):
            break

    depths = {e: o.last_week_survived for e, o in pool.items()}
    return pot_share(depths, [me])


def run(seasons: List[int], rows: List[dict], names: List[str], verbose: bool, starts: int = 1) -> None:
    """One row per strategy: weeks survived per season, and the mean.

    `starts` replays each season from each of weeks 1..starts rather than only
    from week 1. That is not cosmetic. A survivor season is one entry making at
    most eighteen decisions, and the variance is enormous — a single unlucky
    week two ends a run and drags a ten-season mean by half a week. Ten numbers
    cannot separate a real improvement from a good year. Restarting the same
    season at a later week is a genuinely different run (a different board, a
    different used-teams path) and multiplies the sample without inventing
    data, which is the cheapest honesty available here.

    The per-season column stays the week-1 run, so the table still reads as a
    season history; the mean is over every run.
    """
    seasons_data = {
        season: (games_for_season(rows, season), outcome_for(rows, season))
        for season in seasons
    }

    header = f"{'strategy':10} " + " ".join(f"{s:>6}" for s in seasons) + f"  {'mean':>7}"
    print(header)
    print("-" * len(header))

    for name in names:
        first_run: List[int] = []
        every_run: List[int] = []
        for season in seasons:
            by_week, outcomes = seasons_data[season]
            for start in range(1, starts + 1):
                survived, why, log = simulate(by_week, outcomes, STRATEGIES[name], start_week=start)
                every_run.append(survived)
                if start == 1:
                    first_run.append(survived)
                    if verbose:
                        print(f"  {season} {name}: {survived} weeks — {why}", file=sys.stderr)
                        for week, team, result in log:
                            print(f"      wk{week:2} {team:4} {result}", file=sys.stderr)
        mean = sum(every_run) / len(every_run) if every_run else 0.0
        print(f"{name:10} " + " ".join(f"{w:6d}" for w in first_run) + f"  {mean:7.2f}")

    if starts > 1:
        print(f"  mean over {len(seasons) * starts} runs "
              f"({len(seasons)} seasons x {starts} starting weeks)")


def report_pot_share(
    seasons: List[int], rows: List[dict], names: List[str], fields: int = 25,
) -> None:
    """Score every strategy on the metric the pool actually pays, against a field.

    Read the caveat under the table before reading the table.
    """
    print(f"pot share against a simulated {DEFAULT_POOL_SIZE}-entry field, "
          f"{len(seasons)} seasons x {fields} fields\n")
    print(f"    {'strategy':10} {'your depth':>11} {'field best':>11} {'tied best':>10} {'pot share':>11}")
    print("    " + "-" * 56)

    for name in names:
        mine, best, shares, tied = [], [], [], 0
        for season in seasons:
            by_week = games_for_season(rows, season)
            outcomes = outcome_for(rows, season)
            table = build_win_probability_table(
                [g for w in sorted(by_week) for g in by_week[w]]
            )
            for seed in range(fields):
                depth, field_best, share = _one_field(
                    by_week, outcomes, table, STRATEGIES[name], seed
                )
                mine.append(depth)
                best.append(field_best)
                shares.append(share)
                tied += depth == field_best
        n = len(mine)
        # The pot share, not the rate of tying for deepest. Tying is necessary
        # and not sufficient: the pot is split among *everybody* who reached
        # that week, so a tie shared with forty survivors is a fortieth. This
        # column read `tied / n / max(1, 1)` -- the divisor a constant, and the
        # place the number of winners was supposed to go -- which reported the
        # tie rate under the heading "pot share" and overstated it by however
        # many people you tied with. `settle` in models/payout.py is the rule,
        # and it is the same one `report_holdings` scores two entries on.
        print(f"    {name:10} {sum(mine)/n:11.2f} {sum(best)/n:11.2f} "
              f"{tied:8}/{n} {sum(shares)/n:11.5f}")

    print("""
    Every strategy scores about zero, and that is the result rather than a bug.

    A single entry has to match the *deepest of 249 opponents* to take any of
    the pot, and the deepest of 249 usually goes the distance. Your entry lasts
    about four weeks, which is exactly what the literature says a well-played
    entry lasts. The gap is not a failure of these strategies; it is what a
    250-entry pool is.

    The sharper half: none of these strategies models opponents, so they pick
    the same chalk the field picks and die in the same weeks the field dies.
    Correlated with the crowd is the one thing that cannot win a large pool --
    you need the weeks that kill others to be weeks you survive. That is what
    expected pot share is for, and it needs pick popularity, which is not built.

    Until then weeks survived remains the usable metric here: it discriminates
    between these strategies and this does not.""")


def _one_field(by_week, outcomes, table, pick_for, seed: int):
    """One season against one field.

    Returns (your depth, the field's best, your share of the pot). The share
    comes from `models.payout.settle`, which is the pool's actual rule --
    deepest split, among however many reached that week -- rather than from
    whether you merely tied for deepest.
    """
    rng = random.Random(seed)
    pool = field_model.build_field(DEFAULT_POOL_SIZE, ["me"])
    my_used: List[str] = []

    for week in sorted(by_week):
        candidates = []
        for game in by_week[week]:
            for is_home in (True, False):
                resolved = resolve_team_win_probability(game, is_home)
                if resolved.win_pct is not None and resolved.team_abbreviation:
                    candidates.append((resolved.team_abbreviation, resolved.win_pct))
        candidates.sort(key=lambda c: (-c[1], c[0]))
        if not candidates:
            break

        me = pool["me"]
        if me.alive:
            team = pick_for(by_week[week], table, week, my_used)
            if team is None:
                me.alive = False
            else:
                my_used.append(team)
                me.used.add(team)
                if outcomes.get((week, team)) == "win":
                    me.last_week_survived = week
                else:
                    me.alive = False

        for entry_id, opponent in pool.items():
            if entry_id != "me":
                field_model.advance(opponent, candidates, outcomes, week, rng)

        if not any(o.alive for o in pool.values()):
            break

    depths = {k: o.last_week_survived for k, o in pool.items()}
    return (
        depths["me"],
        max(v for k, v in depths.items() if k != "me"),
        pot_share(depths, ["me"]),
    )



# -- two entries ------------------------------------------------------------
#
# The traveller holds two, and everything above replays one. That is not a
# smaller version of the same question: `joint` is a pair search read for half
# its answer, and the naive alternative -- run the single-entry recommender
# twice -- produces two identical entries, which is the one holding that
# cannot hedge anything.

def _board_for(games: List[Game], popularity: Dict[str, float]) -> List[WeekGame]:
    """This week as the pot-share model needs it: prices and a following."""
    board: List[WeekGame] = []
    for game in games:
        home = resolve_team_win_probability(game, True)
        away = resolve_team_win_probability(game, False)
        if home.win_pct is None or not home.team_abbreviation or not away.team_abbreviation:
            continue
        board.append(WeekGame(
            home=home.team_abbreviation,
            away=away.team_abbreviation,
            home_win_prob=home.win_pct / 100.0,
            home_share=popularity.get(home.team_abbreviation, 0.0),
            away_share=popularity.get(away.team_abbreviation, 0.0),
        ))
    return board



def _cached_single(single, games, table, week, used, cache) -> Optional[str]:
    """One entry's pick, memoised on the state that determines it.

    A beam search over the next seven weeks depends on the board, the week and
    what this entry has spent -- and on nothing else. Within one season the
    board is fixed, so `(week, teams spent)` is the whole key.

    That state repeats far more than it looks. `twice` runs the same strategy
    for both entries and they hold identical inventories all the way to the
    first elimination, so its two calls are one. `distinct`'s first entry makes
    the identical call again, since striking a team only affects the second.
    And every field replayed for the same season repeats all of it, because
    the opponents do not change what you would pick.

    Measured within a season rather than across: 220 searches collapse to 42,
    which is 5.2x on the thing the profiler says is 84% of a run. Pooling the
    count across seasons said 5.29x and would have been wrong -- a different
    season is a different board, so the same key is a different answer.

    Keyed on the strategy too, so a second base strategy cannot silently read
    the first one's answers.
    """
    if cache is None:
        return single(games, table, week, used)
    key = (single, week, frozenset(used))
    if key not in cache:
        cache[key] = single(games, table, week, used)
    return cache[key]


def pair_twice(single: Callable) -> Callable:
    """Run a single-entry strategy once per entry, independently.

    The honest baseline, and a bad holding: the strategy is deterministic and
    both entries start with the same empty inventory, so they pick the same
    team every week until one of them dies. Two perfectly correlated entries
    are one entry that cost twice as much, which is exactly the thing a pair
    search has to beat to be worth having.
    """
    def pick(games, table, week, used_lists, context):
        cache = context.get("solve_cache")
        return [
            _cached_single(single, games, table, week, used, cache)
            for used in used_lists
        ]
    return pick


def pair_distinct(single: Callable) -> Callable:
    """The same single-entry strategy, forbidden from picking the same team twice.

    What a person actually does, and the only one of these that isolates the
    pairing decision: entry 2 runs the identical strategy with entry 1's pick
    struck off its inventory, so the *only* difference from `twice` is that
    the two entries are made to diverge. Beating `twice` proves nothing --
    nobody puts both entries on one team on purpose -- and beating this does.

    The first version of this used a different base strategy from `twice`,
    which made the comparison four different rankings rather than four ways of
    pairing one.
    """
    def pick(games, table, week, used_lists, context):
        cache = context.get("solve_cache")
        picks: List[Optional[str]] = []
        taken: List[str] = []
        for used in used_lists:
            choice = _cached_single(
                single, games, table, week, list(used) + taken, cache
            )
            if choice:
                taken.append(choice)
            picks.append(choice)
        return picks
    return pick


def pair_joint(games, table, week, used_lists, context):
    """The existing pair search, read for both of its answers this time.

    Once one entry is out there is no pair left to search, and the pair search
    is not the right thing to ask -- so the survivor falls back to the
    single-entry strategy. Handing joint_optimizer an empty second inventory
    instead would have it hedge against a phantom.
    """
    if len(used_lists) == 1:
        return [_cached_single(
            pick_sequence, games, table, week, used_lists[0], context.get("solve_cache")
        )]
    rec = joint_optimizer.recommend(
        games, week, used_teams_a=list(used_lists[0]), used_teams_b=list(used_lists[1])
    )
    return [
        rec.pick_a.team_abbreviation if rec.pick_a else None,
        rec.pick_b.team_abbreviation if rec.pick_b else None,
    ]


def pair_pot_share(games, table, week, used_lists, context):
    """Rank every legal combination on expected pot share, exactly.

    Two things it needs that no strategy above uses. Popularity, which the
    harness can state exactly because the same weights generate the field's
    picks. And the *terminal* field rather than the current one -- see
    field_model.terminal_field, and the docstring in models/joint_pot_share.py
    for what happens if you pass the wrong one.
    """
    board = _board_for(games, context["popularity"])
    if not board:
        return [None] * len(used_lists)
    playing = {t for g in board for t in (g.home, g.away)}
    inventories = [sorted(playing - set(used)) for used in used_lists]

    # An entry with nothing playable left is out, and only that entry. The
    # first version returned None for the whole holding the moment any one of
    # them ran dry, and the harness reads None as elimination -- so one entry
    # running out took a live one with plenty of options down with it. Hard to
    # reach with a full 32-team board and not hard at all once `_board_for`
    # has dropped games with no price, which is what happens on real data.
    live = [i for i, inv in enumerate(inventories) if inv]
    if not live:
        return [None] * len(used_lists)

    best = rank_holdings(
        board, [inventories[i] for i in live], context["terminal_field"], limit=1
    )
    if not best:
        return [None] * len(used_lists)
    picks: List[Optional[str]] = [None] * len(used_lists)
    for slot, team in zip(live, best[0].teams):
        picks[slot] = team
    return picks


def pair_leverage(
    tolerance_pct: float = leverage.DEFAULT_TOLERANCE_PCT,
    min_gain: float = leverage.DEFAULT_MIN_GAIN,
) -> Callable:
    """`distinct`, then off the crowd where the board makes it nearly free.

    Scored on the *inventories* rather than on `context["popularity"]`, and
    that is the whole design of this measurement. Handing it the popularity the
    harness computes would hand it the true generating distribution -- an
    oracle no real pool provides -- and every pot-share strategy scored that
    way in this file looked good at a small sample and reversed at a larger
    one. This forecasts for itself, from the same inventory table `/api/pool`
    returns, so what is being measured is what would actually run on a Sunday.

    `forecast_tau` still varies independently of the field's true tau under
    `--robustness`, so the case where the strategy is simply wrong about how
    chalky the pool is stays measurable.
    """
    def pick(games, table, week, used_lists, context):
        base = pair_distinct(pick_sequence)(games, table, week, used_lists, context)
        inventories = context.get("inventories") or []
        if not inventories:
            return base

        board = [
            (c.team_abbreviation, c.win_pct)
            for c in sequence_dp._options_this_week(games, set())
            if c.win_pct is not None
        ]
        if not board:
            return base
        forecast = field_model.popularity_from_inventories(inventories, board)

        out: List[Optional[str]] = list(base)
        taken = [t for t in base if t]
        for slot, (used, chosen) in enumerate(zip(used_lists, base)):
            if chosen is None:
                continue
            others = [t for t in taken if t != chosen]
            options = sequence_dp._options_this_week(games, set(used) | set(others))
            current = next((o for o in options if o.team_abbreviation == chosen), None)
            if current is None:
                continue
            moved = leverage.least_crowded(
                options, current, forecast, tolerance_pct, min_gain
            )
            if moved.team_abbreviation == chosen:
                continue
            out[slot] = moved.team_abbreviation
            taken = [moved.team_abbreviation if t == chosen else t for t in taken]
        return out
    return pick


def pair_pot_share_horizon(weeks_ahead: Optional[int]) -> Callable:
    """`potshare` with the terminal field projected a fixed distance ahead.

    The one dial the measurements actually point at. `potshare` assumes it is
    splitting with the field that survives to Week 18, which from Week 1 is
    under one opponent -- as contrarian as the model can possibly be. The
    robustness grid said twice that this is overdone: told the field is *more*
    spread out than it truly is, the model scored better than told the truth,
    which is what an excessive tilt looks like from the outside.

    `weeks_ahead` is how far to project. None is the shipped behaviour (all
    the way to Week 18); 0 uses the field alive right now, which makes it
    behave like a plain expected-value pick; the numbers between are the
    interesting part.
    """
    def pick(games, table, week, used_lists, context):
        alive = max(1, context["opponents_alive"])
        if weeks_ahead is None:
            terminal = context["terminal_field"]
        else:
            terminal = field_model.terminal_field(
                alive, week, final_week=week + weeks_ahead
            )
        return pair_pot_share(
            games, table, week, used_lists, {**context, "terminal_field": terminal}
        )
    return pick


def pair_sequential(games, table, week, used_lists, context):
    """Entry A on value, Entry B hedged against whatever A took.

    The app's `sequential` strategy, which is a *pair* strategy rather than a
    single one run twice -- B is told A's team and takes the safest option
    from a different game. It is here because every way of picking that the
    app offers has to have a number beside it, and the three that did not
    were being presented to the reader as equals of the ones that did.
    """
    cache = context.get("solve_cache")
    picks: List[Optional[str]] = []
    first: Optional[str] = None
    for i, used in enumerate(used_lists):
        if i == 0:
            first = _cached_single(pick_value, games, table, week, used, cache)
            picks.append(first)
            continue
        rec = entry_b_hedge.recommend(
            games, week, used_teams=list(used), entry_a_pick_team=first
        )
        picks.append(rec.pick.team_abbreviation if rec.pick else None)
    return picks


PAIR_STRATEGIES: Dict[str, Callable] = {
    "potshare": pair_pot_share,
    # The horizon sweep. Named by how many weeks ahead the field is projected,
    # so `ps-h0` splits with the field alive today and `potshare` splits with
    # whoever is left in Week 18.
    "ps-h0": pair_pot_share_horizon(0),
    "ps-h2": pair_pot_share_horizon(2),
    "ps-h4": pair_pot_share_horizon(4),
    "ps-h8": pair_pot_share_horizon(8),
    "joint": pair_joint,
    "distinct": pair_distinct(pick_sequence),
    # The app's six ways of picking, so every one of them has a measured
    # number beside it in the picker rather than three of them being shown as
    # equals of the three that were raced. `twice` is the app's `sequence`:
    # a single-entry strategy run once per entry, which is what the app does
    # with any strategy declaring entries: 'single'.
    "twice": pair_twice(pick_sequence),
    "ranked": pair_twice(pick_ranked),
    "value": pair_twice(pick_value),
    "sequential": pair_sequential,
    # The field-aware one, and the tolerance sweep that says whether the idea
    # has a size at all. `lev-0` is `distinct` exactly -- it is in the table as
    # the control, so a run that shows the whole sweep level with it is showing
    # that in one line rather than needing a second run to compare against.
    "leverage": pair_leverage(),
    # The control: zero tolerance is `distinct` exactly, so a run showing the
    # whole sweep level with it is showing in one line that the idea has no
    # size, without needing a second run to compare against.
    "lev-0": pair_leverage(0.0),
    # The tolerance sweep, at the shipped minimum gain.
    "lev-t1": pair_leverage(1.0),
    "lev-t4": pair_leverage(4.0),
    # The gain sweep, at the shipped tolerance. `lev-g0` is the first version
    # of this strategy -- move to the least-crowded team in the band whatever
    # it buys -- kept in the table so the shape of DEFAULT_MIN_GAIN stays
    # runnable. What it does *not* do is justify that parameter on pot share:
    # over 10,000 seasons it is t = 0.75 from `distinct` and 0.64 from
    # `leverage`, neither a separation. See strategy/leverage.py.
    "lev-g0": pair_leverage(2.0, 0.0),
    "lev-g30": pair_leverage(2.0, 0.30),
}


@dataclass
class FieldRun:
    """One simulated field's whole season, which does not depend on your picks.

    The opponents never see your entries: their inventories, their picks and
    the random stream driving them are the same whichever strategy you are
    testing. Simulating them once and sharing the result is therefore not an
    approximation -- it is the same numbers, four times faster on a four-way
    comparison and twenty times on the robustness grid, which is the
    difference between three hundred seasons and thirty.

    It is also a stronger guarantee than common random numbers by seed: the
    strategies are no longer *given* identical fields, they are given the
    identical field object.
    """

    candidates: Dict[int, List[Tuple[str, float]]]
    inventories: Dict[int, List[Set[str]]]   # alive opponents, per week
    depths: Dict[str, int]
    best: int


def _candidates_for(games: List[Game]) -> List[Tuple[str, float]]:
    """Every team playing, with its advance probability, best first."""
    out: List[Tuple[str, float]] = []
    for game in games:
        for is_home in (True, False):
            resolved = resolve_team_win_probability(game, is_home)
            if resolved.win_pct is not None and resolved.team_abbreviation:
                out.append((resolved.team_abbreviation, resolved.win_pct))
    out.sort(key=lambda c: (-c[1], c[0]))
    return out


def run_field(
    by_week, outcomes, seed: int, entries: int = 2,
    field_tau: float = field_model.CASUAL_TAU,
) -> FieldRun:
    """Simulate the 248 opponents for a whole season, and nothing else."""
    rng = random.Random(seed)
    my_ids = [f"me{i}" for i in range(entries)]
    pool = field_model.build_field(DEFAULT_POOL_SIZE, my_ids)
    opponents = {k: o for k, o in pool.items() if k not in my_ids}

    candidates: Dict[int, List[Tuple[str, float]]] = {}
    inventories: Dict[int, List[Set[str]]] = {}
    for week in sorted(by_week):
        week_candidates = _candidates_for(by_week[week])
        if not week_candidates:
            break
        candidates[week] = week_candidates
        # Snapshotted *before* the week is played, which is when a strategy
        # picking for that week would see them.
        inventories[week] = [set(o.used) for o in opponents.values() if o.alive]
        for opponent in opponents.values():
            field_model.advance(
                opponent, week_candidates, outcomes, week, rng, tau=field_tau
            )

    depths = {k: o.last_week_survived for k, o in opponents.items()}
    return FieldRun(candidates, inventories, depths, max(depths.values(), default=0))


def _one_field_holding(
    by_week, outcomes, table, pick_pair, seed: int, entries: int = 2,
    field_tau: float = field_model.CASUAL_TAU,
    forecast_tau: Optional[float] = None,
    field_run: Optional[FieldRun] = None,
    solve_cache: Optional[Dict] = None,
):
    """One season, one holding of `entries`, against one simulated field.

    Returns (pot share, your deepest entry, the field's deepest, twinned
    weeks, weeks both entries picked).

    `field_tau` is how the field actually behaves; `forecast_tau` is what the
    strategy is *told* it does. They are the same by default, which hands a
    pot-share strategy the true generating distribution -- the best case, and
    one it will never get in a real pool where nobody knows how chalky the
    field is. Pulling them apart is what `--robustness` measures.
    """
    if forecast_tau is None:
        forecast_tau = field_tau
    if field_run is None:
        field_run = run_field(by_week, outcomes, seed, entries, field_tau)

    my_ids = [f"me{i}" for i in range(entries)]
    used_lists: List[List[str]] = [[] for _ in my_ids]
    alive = [True] * entries
    survived = [0] * entries
    twinned = weeks_both_picked = 0

    for week in sorted(field_run.candidates):
        living = [i for i in range(entries) if alive[i]]
        if not living:
            break
        candidates = field_run.candidates[week]
        opponents_alive = len(field_run.inventories[week])
        context = {
            "popularity": field_model.popularity_from_inventories(
                field_run.inventories[week], candidates, tau=forecast_tau
            ),
            "terminal_field": field_model.terminal_field(max(1, opponents_alive), week),
            "opponents_alive": opponents_alive,
            # The raw inventories, not just the distribution derived from them.
            # `leverage` forecasts popularity itself, from exactly the input the
            # real app gets off /api/pool -- which is the whole point of
            # measuring it: handing it `popularity` above would be handing it
            # the true generating distribution, and every pot-share strategy
            # that was scored that way looked good and then reversed.
            "inventories": field_run.inventories[week],
            "week": week,
            "solve_cache": solve_cache,
        }
        picks = pick_pair(
            by_week[week], table, week, [used_lists[i] for i in living], context
        )
        if len(living) == entries and all(picks):
            weeks_both_picked += 1
            if len(set(picks)) == 1:
                twinned += 1
        for slot, team in zip(living, picks):
            if team is None:
                alive[slot] = False
                continue
            used_lists[slot].append(team)
            if outcomes.get((week, team)) == "win":
                survived[slot] = week
            else:
                alive[slot] = False

    depths = dict(field_run.depths)
    for i, entry_id in enumerate(my_ids):
        depths[entry_id] = survived[i]
    return (
        pot_share(depths, my_ids),
        max(survived),
        field_run.best,
        twinned,
        weeks_both_picked,
    )



# -- one season, in its own process ------------------------------------------
#
# Seasons are independent and every part of one is deterministic given its tag
# and seed: the generator, the field, and all four strategies. So splitting
# them across cores is exact rather than approximate -- the same arithmetic on
# a different core -- and there is a test asserting the answers match.
#
# The rows for a *real* replay are large and are inherited through fork rather
# than pickled per task. On a platform without fork this falls back to one
# process, which is slower and still correct.

_WORKER_ROWS: List[dict] = []


def _season_payload(tag, by_week, outcomes, names, fields, field_tau, beliefs):
    """Everything one season contributes, as plain numbers."""
    table = build_win_probability_table(
        [g for w in sorted(by_week) for g in by_week[w]]
    )
    solve_cache: Dict = {}
    # Per strategy, every one of these -- `wins`, `same` and `picked` are
    # properties of a strategy's run, not of the season, and folding them
    # together would report one number four times.
    out = {
        "tag": tag,
        "shares": {name: [] for name in names},
        "mine": {name: [] for name in names},
        "theirs": {name: [] for name in names},
        "wins": {name: 0 for name in names},
        "same": {name: 0 for name in names},
        "picked": {name: 0 for name in names},
        "belief": {(b, name): [] for b in (beliefs or ()) for name in names},
    }
    for k in range(fields):
        seed = hash((tag, k)) & 0xFFFF
        field_run = run_field(by_week, outcomes, seed, field_tau=field_tau)
        for name in names:
            share, best, field_best, twin, picks = _one_field_holding(
                by_week, outcomes, table, PAIR_STRATEGIES[name], seed=seed,
                field_tau=field_tau, field_run=field_run, solve_cache=solve_cache,
            )
            out["shares"][name].append(share)
            out["mine"][name].append(best)
            out["theirs"][name].append(field_best)
            out["same"][name] += twin
            out["picked"][name] += picks
            if share > 0:
                out["wins"][name] += 1
        for belief in (beliefs or ()):
            for name in names:
                out["belief"][(belief, name)].append(_one_field_holding(
                    by_week, outcomes, table, PAIR_STRATEGIES[name], seed=seed,
                    field_tau=field_tau, forecast_tau=belief, field_run=field_run,
                    solve_cache=solve_cache,
                )[0])
    return out


def _season_task(args):
    tag, names, fields, synthetic, field_tau, beliefs = args
    if synthetic:
        by_week, outcomes, _ = synth.season(tag)
    else:
        by_week = games_for_season(_WORKER_ROWS, tag)
        outcomes = outcome_for(_WORKER_ROWS, tag)
    return _season_payload(tag, by_week, outcomes, names, fields, field_tau, beliefs)


def _run_seasons(tags, names, rows, fields, synthetic, jobs,
                 field_tau=None, beliefs=()):
    """Every season's payload, in order, across `jobs` processes."""
    global _WORKER_ROWS
    if field_tau is None:
        field_tau = field_model.CASUAL_TAU
    work = [(tag, list(names), fields, synthetic, field_tau, tuple(beliefs))
            for tag in tags]

    if jobs <= 1 or len(work) < 2:
        for done, item in enumerate(work, start=1):
            _WORKER_ROWS = rows
            _progress(done, len(work))
            yield _season_task(item)
        return

    _WORKER_ROWS = rows   # inherited by the children through fork
    ctx = multiprocessing.get_context("fork")
    with ctx.Pool(processes=jobs) as pool:
        for done, payload in enumerate(pool.imap(_season_task, work, chunksize=4), start=1):
            _progress(done, len(work))
            yield payload


def season_tags(seasons: List[int], rows: List[dict], synthetic: int = 0) -> List[object]:
    """Just the labels, so a report can index its per-season results."""
    if synthetic:
        return list(range(synthetic))
    return [s for s in seasons if games_for_season(rows, s)]


def seasons_to_replay(
    seasons: List[int], rows: List[dict], synthetic: int = 0
):
    """Every season to replay, as (label, slate by week, outcomes).

    A generator, not a list, and that is not a style preference. Building all
    of them up front held two thousand seasons live at once -- about half a
    gigabyte and two million objects -- so every garbage collection walked the
    entire set. The run took twice what a calibration on the same code
    predicted, because the calibration generated one season at a time and let
    each be collected. Yielding costs nothing and keeps the live set to one.

    One shape whether the seasons are real or generated, so the reports have a
    single code path and cannot drift between the two. See scripts/synth.py
    for why the generated ones exist: ten real seasons cannot separate these
    strategies, and there will never be an eleventh.
    """
    if synthetic:
        for i in range(synthetic):
            by_week, outcomes, _ = synth.season(i)
            yield (i, by_week, outcomes)
        return
    for season in seasons:
        by_week = games_for_season(rows, season)
        if by_week:
            yield (season, by_week, outcome_for(rows, season))


def _progress(done: int, total: int) -> None:
    """A season counter, on stderr so it never lands in a redirected report.

    Sharing one field across strategies made the loop go seasons-first, which
    is what made it fast and also meant nothing printed until every season was
    finished -- four hundred of them, in silence, indistinguishable from a
    hang. Cheap to fix and worth fixing: a run nobody can tell is working is a
    run somebody kills.
    """
    # Twenty updates at most, and none at all on a run short enough that the
    # whole thing lands before anybody wonders. Below the threshold `total //
    # 20` is 1 and every season prints, which is the noise this avoids.
    if total < 40:
        return
    if done % (total // 20) and done != total:
        return
    sys.stderr.write(f"\r  {done}/{total} seasons")
    if done == total:
        sys.stderr.write("\n")
    sys.stderr.flush()


def report_holdings(
    seasons: List[int], rows: List[dict], names: List[str],
    fields: int = 25, synthetic: int = 0, jobs: int = 1,
    field_tau: Optional[float] = None,
) -> None:
    """Two entries, scored on what the pool pays.

    ── On real seasons, read the per-season block, not the mean ────────────

    Three of these four strategies pick deterministically -- the same season
    gives the same picks whatever the seed -- so `fields` varies the
    *opponents* only, and the sample is the number of seasons. Measured over
    2015-2024 with 20 fields a season:

                    2020    2021    other eight
        twice      0.291   0.000    0.000
        distinct   0.177   0.000    0.000
        joint      0.177   0.000    0.000
        potshare   0.029   0.042    0.000

    Two seasons of ten paid anything at all, so each strategy's ten-season
    mean rests on a single year and none of them is a measurement. Do not
    quote them as an ordering.

    Two things in there are worth keeping anyway. In 2020, the one season the
    chalk went perfect, `twice` -- two *identical* entries -- beat forcing
    them apart, 0.291 against 0.177: both copies cashed, where making the
    second diverge sent it to a worse team and killed it. Correlation only
    costs you in the seasons you would otherwise have lost. And `potshare` is
    the only strategy that cashed in a *second* season, which is the shape you
    would expect from one trading depth for being alone, and is one
    observation rather than evidence.

    ── What the measurements settled ───────────────────────────────────────

    The current published table is at **10,000** seasons and lives in
    deadpool/src/engine/measured.js; read that for what the ratings are today.
    What follows is the 2,500-season run, kept because it is the one that
    falsified `potshare` and `ps-h4` and those two are not in the current table
    at all. It is history with a sample size attached, not the live answer.

    2,500 seasons, paired:

        better     vs          mean diff     ± se      t       seasons
        distinct   twice         0.00644  0.00143   4.50     51 vs 39
        ps-h4      twice         0.00511  0.00253   2.02     75 vs 49
        potshare   twice         0.00377  0.00250   1.51     61 vs 49
        distinct   potshare      0.00267  0.00275   0.97     94 vs 58
        ps-h4      potshare      0.00134  0.00266   0.50     71 vs 59
        distinct   ps-h4         0.00133  0.00277   0.48     91 vs 70

    **`distinct` is the answer**, and it is the simplest thing available: run
    one strategy twice and strike the first entry's pick from the second's
    inventory. 1.96x fair, Week 6.6, and t = 4.50 over two identical entries
    -- the strongest result in this harness.

    **Do not hold two identical entries.** `twice` returns 1.16x fair, which
    is barely above playing at random, and dies around Week 4.6.

    **Nothing built on expected pot share beats it, at any tilt.** `potshare`
    loses 94 seasons to 58. The horizon sweep -- `ps-h0` through `ps-h8`,
    projecting the terminal field a fixed distance instead of to Week 18 --
    was the one dial the robustness grid pointed at, and it does not rescue
    the idea: the best of them still trails `distinct`.

    ── The same 2,500 seasons, with teams that drift ───────────────────────

    The generator used to hold a team as good in Week 18 as in Week 1, which
    flatters any strategy hoarding a good team for later. Real market-implied
    strength moves 0.136 a week, nearly as far over a season as the league is
    wide. With that in (see scripts/synth.py):

        better     vs          mean diff     ± se      t       seasons
        distinct   twice         0.00604  0.00145   4.17     45 vs 31
        ps-h4      twice         0.00674  0.00246   2.74     54 vs 36
        potshare   twice         0.00592  0.00234   2.53     60 vs 37
        ps-h4      potshare      0.00082  0.00255   0.32     48 vs 54
        ps-h4      distinct      0.00070  0.00263   0.27     52 vs 75
        distinct   potshare      0.00012  0.00259   0.05     77 vs 59

    **The recommendation does not change.** `distinct` still leads the
    head-to-head against everything -- 75 seasons to 52 over `ps-h4`, 77 to 59
    over `potshare` -- and nothing separates from it on the paired error.

    What changes is that the world gets harder for everybody. Every strategy
    loses about a fifth of its return (`distinct` 1.96x to 1.61x), because a
    team held back for Week 12 may not be worth holding by Week 12. The field
    survives slightly longer, which is the same effect seen from the other
    side: opponents forced off spent chalk onto a team that has since improved.

    And **`twice` drops below fair**, 1.16x to 0.86x. Two identical entries now
    return less than picking at random, which sharpens the one instruction this
    harness has ever established.

    Note `ps-h4` posts the higher *mean* here (1.70x against 1.61x) while
    losing the season count 52 to 75. That is a heavy tail, not an edge -- it
    wins bigger and less often -- and given that a flattering mean at a smaller
    sample has already reversed twice in this file, the count is the half to
    believe.

    ── Two strategies that looked good and were not ─────────────────────────

    Worth keeping because both fooled me the same way, and the pattern is the
    lesson rather than either result.

    `potshare` at 400 seasons: 3.02x fair, t = 2.99 over `twice`, 25 seasons
    to 6. At 2,000 it was t = 1.01 and behind everything simple.

    `ps-h4` at 800 seasons: 2.42x fair, the highest mean of eight strategies,
    winning more seasons than it lost against every one of them. At 2,500 it
    was 1.80x and behind `distinct`.

    The metric pays nobody in about 96% of seasons, so a mean rides on a
    handful and the tail is heavy enough that **t near 3 at n = 400 was not
    safe**, which is not what a t-statistic usually implies. The bar here is
    therefore not the conventional one: **t > 2 is a hypothesis until it holds
    at several times the sample.** The two surviving results did exactly that,
    growing like sqrt(n) as a real effect should -- `distinct` over `twice`
    went 2.11 at 400, 3.73 at 2,000, 4.50 at 2,500, and 10.95 at 10,000.

    ── Which is what --synthetic is for ────────────────────────────────────

    Ten seasons of a metric that is zero 80% of the time cannot separate four
    strategies, and there will never be an eleventh. `--synthetic N` replays N
    generated seasons instead, fitted to the real distribution and with the
    true probabilities handed to every strategy, so a gap between two of them
    is a policy difference rather than one having a better read on the games.
    See scripts/synth.py. At that point the mean is worth reading and a
    standard error is printed beside it.
    """
    tags = season_tags(seasons, rows, synthetic)
    if not tags:
        print("no seasons to replay")
        return

    label = f"{len(tags)} synthetic seasons" if synthetic else f"{len(tags)} seasons"
    tau = field_model.CASUAL_TAU if field_tau is None else field_tau
    print(f"two entries, {DEFAULT_POOL_SIZE}-entry pool, {fields} simulated fields "
          f"per season, {label}")
    # Named because it is the assumption every pot-share number here rests on
    # and it used to be invisible: the field's concentration was CASUAL_TAU in
    # every run ever published, with nothing on the page saying so.
    print(f"the field behaves at tau={tau} (lower is chalkier)\n")
    print(f"  {'strategy':<10} {'pot share':>10} {'± se':>8} {'x fair':>8} {'$ back':>8} "
          f"{'deepest':>8} {'field':>7} {'paid':>6} {'same pick':>10}")
    print("  " + "-" * 83)

    fair = 2.0 / DEFAULT_POOL_SIZE
    by_season: Dict[str, Dict[object, float]] = {name: {} for name in names}
    # The same per-season reduction on weeks survived. It was always computed
    # -- the `deepest` column is its grand mean -- and always thrown away
    # before it could be paired, which left the low-variance metric with no
    # error bar while the high-variance one carried all the conclusions.
    depth_by_season: Dict[str, Dict[object, float]] = {name: {} for name in names}
    stats = {name: {"shares": [], "mine": [], "theirs": [], "wins": 0,
                    "same": 0, "total": 0} for name in names}

    for payload in _run_seasons(tags, names, rows, fields, synthetic, jobs,
                                field_tau=field_tau):
        tag = payload["tag"]
        for name in names:
            got = payload["shares"][name]
            s = stats[name]
            s["shares"].extend(got)
            by_season[name][tag] = sum(got) / len(got)
            deep = payload["mine"][name]
            depth_by_season[name][tag] = sum(deep) / len(deep)
            s["mine"].extend(payload["mine"][name])
            s["theirs"].extend(payload["theirs"][name])
            s["wins"] += payload["wins"][name]
            s["same"] += payload["same"][name]
            s["total"] += payload["picked"][name]

    for name in names:
        s = stats[name]
        shares, mine, theirs = s["shares"], s["mine"], s["theirs"]
        wins, same, total = s["wins"], s["same"], s["total"]
        if not shares:
            continue
        # The independent unit is the season, not the field: the fields
        # resample opponents against picks that did not change. So the error
        # is over season means, and n is the number of seasons.
        means = list(by_season[name].values())
        avg = sum(means) / len(means)
        se = _standard_error(means)
        print(f"  {name:<10} {avg:10.5f} {se:8.5f} {avg/fair:8.2f} "
              f"{avg * DEFAULT_POOL_SIZE * 10:8.2f} "
              f"{sum(mine)/len(mine):8.2f} {sum(theirs)/len(theirs):7.2f} "
              f"{wins/len(shares):6.1%} {(same/total if total else 0):10.1%}")

    _paired(by_season, names, tags, metric="pot share", fmt="10.5f",
            heading="what the pool pays, and the noisiest thing here.")
    _paired(depth_by_season, names, tags, metric="weeks survived", fmt="10.3f",
            heading="the same seasons, lower variance, a different question.")

    print("""
  `t` over about 2 is a difference this many seasons can see; under it the two
  have not been separated whatever the means say. `seasons` counts where each
  beat and lost to the other, ignoring the ties.

  Read the two tables against each other rather than picking one. Pot share is
  what the pool actually pays and is zero in about 96% of seasons, so it ties
  constantly and needs an enormous sample to say anything. Weeks survived pays
  nothing by itself, ties far less, and separates on a sample this one can
  afford. A pair that separates on depth and not on money survived longer
  without converting it; a pair that separates on money and not on depth
  lasted exactly as long and shared with fewer people. Both are findings, and
  neither table alone can tell you which one you are looking at.""")

    if not synthetic:
        print(f"\n  the same numbers by season, which is where the sample actually is:\n")
        print("  " + " " * 10 + "".join(f"{t:>8}" for t in tags))
        for name in names:
            row = "".join(f"{by_season[name].get(t, 0.0):8.3f}" for t in tags)
            print(f"  {name:<10}{row}")
        live = [t for t in tags if any(by_season[n].get(t) for n in names)]
        print(f"\n  seasons that paid anything at all: "
              f"{', '.join(str(s) for s in live) or 'none'} of {len(tags)}.")

    print("""
  `x fair` is against two entries played at random, which is 2/250 of the pot
  for $20 staked. `deepest` is how far the better of the two got, `field` how
  far the best of the 248 opponents got, `paid` how often you took any share
  at all -- including the degenerate case where the whole field died in the
  same week and everybody tied for deepest. `same pick` is how often both
  entries landed on the same team.

  `± se` is over *season* means, because three of these four pick
  deterministically: the fields resample opponents against picks that did not
  change, so a season is one observation however many fields are run. Two
  strategies whose intervals overlap have not been separated.""")



def _paired(
    by_season: Dict[str, Dict[object, float]], names: List[str], tags: List[object],
    metric: str = "pot share", fmt: str = "10.5f", heading: str = "",
) -> None:
    """Every pairing, season by season, because the levels cannot be compared.

    The marginal ± above overstates the uncertainty on a *comparison*, and the
    comparison is what anybody reads the table for. Every strategy here sees
    the identical seasons and, since run_field is shared, the identical fields
    -- so the right statistic is the mean of the per-season difference, whose
    error is over that difference rather than over the level.

    The level varies enormously between seasons (most pay nothing, a few pay
    the whole pot) and that variance is common to all of them, so pairing
    removes most of it. Where the marginal intervals overlap and the paired
    one does not, the paired one is right.

    Every pair rather than every strategy against a floor. The first version
    compared only against `twice`, which answers "is this better than holding
    two identical entries" -- worth knowing, and not the question. The
    question is whether the expensive strategy beats the cheap one, and that
    needs its own error rather than the difference of two errors against a
    third thing.

    ── Why this runs over two metrics rather than one ──────────────────────

    It used to run only over pot share, which is what the pool pays and is
    also the noisiest thing this harness produces. Pot share is zero in about
    96% of seasons, so most *pairs* of strategies tie in most seasons: over
    10,000 seasons `distinct` against `joint` had 674 seasons where either was
    ahead and 9,326 ties. The comparison rests on the 674. That is why more
    seasons kept not settling it -- each one buys about a fifteenth of what
    the sample size suggests, and no amount of running settles a question the
    metric is throwing away its own data on.

    Weeks survived does not have that problem. It is a real number in every
    season rather than a zero in nineteen of twenty, so far more seasons carry
    information about the difference, and the same run answers the question at
    a much lower error.

    It is a *different* question, and both are printed because the gap between
    them is the interesting part. Pot share is what pays. Depth is how long
    you lasted. A strategy can survive exactly as long and take more money by
    sharing with fewer people -- that is precisely what `leverage` looked like
    it was doing before the larger sample took it apart -- and a strategy can
    survive longer and take no more. Neither table is a substitute for the
    other, and where they disagree that disagreement is the finding.
    """
    if len(names) < 2:
        return
    print(f"\n  paired, season by season, on {metric.upper()} --")
    if heading:
        print(f"  {heading}")
    print()
    print(f"  {'better':<10} {'vs':<10} {'mean diff':>10} {'± se':>8} {'t':>6}  {'seasons':>12}")
    print("  " + "-" * 62)

    rows = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            diffs = [by_season[a][tag] - by_season[b][tag] for tag in tags]
            mean = sum(diffs) / len(diffs)
            se = _standard_error(diffs)
            # Report the winner first, so the sign is always positive and the
            # row reads as a claim rather than as a subtraction. Count strictly
            # on both sides: a tied season is neither, and the first version
            # folded every tie into the second-named strategy's column -- which
            # on a metric that ties in four seasons of five read as "30 vs 0"
            # on a difference one season wide.
            ahead = sum(1 for d in diffs if d > 0)
            behind = sum(1 for d in diffs if d < 0)
            if mean >= 0:
                hi, lo, wins, losses = a, b, ahead, behind
            else:
                hi, lo, wins, losses = b, a, behind, ahead
            mean = abs(mean)
            rows.append((mean / se if se else 0.0, hi, lo, mean, se, wins, losses))

    for t_stat, hi, lo, mean, se, wins, losses in sorted(rows, reverse=True):
        print(f"  {hi:<10} {lo:<10} {mean:{fmt}} {se:{fmt}} {t_stat:6.2f}  "
              f"{wins:>5} vs {losses:<5}")

    # The count that explains why a t is small, and the one this harness spent
    # three runs not printing. A tied season is not evidence either way, so a
    # pair's real sample is the seasons where one of them was actually ahead.
    best = max((w + l) for _, _, _, _, _, w, l in rows)
    worst = min((w + l) for _, _, _, _, _, w, l in rows)
    print(f"\n  informative seasons -- where either was ahead -- run from {worst} "
          f"to {best}\n  of {len(tags)}. A pair that ties is not evidence, so that "
          f"range is the\n  sample these t values actually have.")


def _standard_error(values: List[float]) -> float:
    """Standard error of the mean. Zero for a single observation, honestly."""
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / (n - 1)
    return (var / n) ** 0.5



def report_robustness(
    seasons: List[int], rows: List[dict], names: List[str],
    fields: int = 2, synthetic: int = 200, jobs: int = 1,
) -> None:
    """How fast a pot-share strategy falls apart when its view of the field is wrong.

    The one measurement that decides whether any of this is usable. Everywhere
    else in this harness a pot-share strategy is handed the field's *true*
    pick distribution, because the same weights generate the opponents' picks.
    That is the right way to compare policies -- it removes model error, so a
    gap is a policy gap -- and it is not a situation that ever occurs. In the
    real pool nobody knows how chalky the field is, and the first week of
    observed picks does not arrive until Week 1 has kicked off.

    So the field keeps behaving at `CASUAL_TAU` and the strategy is told
    something else. Low tau means "I think the field piles onto the favourite";
    high tau means "I think it spreads out". The middle row is the oracle.

    A strategy whose advantage survives only at the oracle row is a strategy
    that cannot be used, however well it scores elsewhere.
    """
    tags = season_tags(seasons, rows, synthetic)
    if not tags:
        print("no seasons to replay")
        return

    field_tau = field_model.CASUAL_TAU
    beliefs = [0.15, 0.25, field_tau, 0.50, 0.70]
    print(f"the field behaves at tau={field_tau} throughout; the strategy is told otherwise.")
    print(f"{len(tags)} synthetic seasons, {fields} fields each. Pot share, "
          f"x fair (2/250).\n")

    head = "  " + f"{'told tau':<10}" + "".join(f"{n:>12}" for n in names)
    print(head)
    print("  " + "-" * (len(head) - 2))

    fair = 2.0 / DEFAULT_POOL_SIZE
    # One field per (season, k), reused across every belief *and* every
    # strategy: what the strategy is told does not change what the field does,
    # so this grid is twenty simulations of the same thing collapsed to one.
    means: Dict[Tuple[float, str], List[float]] = {
        (belief, name): [] for belief in beliefs for name in names
    }
    for payload in _run_seasons(tags, names, rows, fields, synthetic, jobs,
                                field_tau=field_tau, beliefs=beliefs):
        for key, values in payload["belief"].items():
            means[key].append(sum(values) / len(values))

    for belief in beliefs:
        cells = []
        for name in names:
            season_means = means[(belief, name)]
            avg = sum(season_means) / len(season_means)
            se = _standard_error(season_means)
            cells.append(f"{avg/fair:7.2f}±{se/fair:4.2f}")
        marker = "  <- the truth" if belief == field_tau else ""
        print(f"  {belief:<10.2f}" + "".join(f"{c:>12}" for c in cells) + marker)

    # What being wrong actually costs, paired against the truth. Same seasons
    # and the same fields down a column, so the difference has far less error
    # in it than the two levels do -- the same argument as `_paired`.
    readers = [
        name for name in names
        if any(means[(b, name)] != means[(field_tau, name)] for b in beliefs)
    ]
    if readers:
        print(f"\n  what being wrong costs, paired against the oracle row:\n")
        print(f"  {'strategy':<10} {'told':>6} {'mean diff':>10} {'± se':>8} {'t':>6}")
        print("  " + "-" * 44)
        for name in readers:
            truth = means[(field_tau, name)]
            for belief in beliefs:
                if belief == field_tau:
                    continue
                diffs = [a - b for a, b in zip(means[(belief, name)], truth)]
                mean = sum(diffs) / len(diffs)
                se = _standard_error(diffs)
                t_stat = 0.0 if not se else mean / se
                print(f"  {name:<10} {belief:6.2f} {mean:10.5f} {se:8.5f} {t_stat:6.2f}")

    print("""
  Only a strategy that reads popularity can move down a column. The others
  never touch the forecast and the seed is unchanged, so their columns come
  out *byte-identical* rather than merely close -- which is a stronger control
  than it looks: a control column that varied at all would mean the belief was
  leaking somewhere it should not. They are also why the paired block above
  lists only the readers: a control has nothing to be wrong about.

  A negative mean diff is what being wrong costs. A positive one says the
  strategy does better believing something false than believing the truth,
  which is not a paradox but a diagnosis -- it means the tilt the model
  applies at the true tau is too strong, and the wrong belief is damping it.""")


def _same_shape(stand_in: Callable, real: Callable) -> None:
    """Refuse a stand-in that cannot be called the way the real function is.

    A monkeypatched replacement is only honest while its signature matches, and
    a signature is exactly the kind of thing that moves under one without the
    other noticing -- here it did, and `--compare-win-prob` raised TypeError on
    the first priced game of every configuration.

    Positional names are compared rather than counts, so a parameter that is
    merely reordered is caught too. Defaults are not: a stand-in is allowed to
    give a trailing option a default the real one gets from the caller.
    """
    want = [
        p.name for p in inspect.signature(real).parameters.values()
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
    ]
    got = [
        p.name for p in inspect.signature(stand_in).parameters.values()
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
    ]
    if got != want:
        raise TypeError(
            f"{stand_in.__name__} stands in for {real.__name__} but takes {got} "
            f"where the real one takes {want}; the replay would raise on the "
            f"first game it scored."
        )


def compare_win_prob(seasons: List[int], rows: List[dict], names: List[str], starts: int = 1) -> None:
    """Replay under each rung of the source ladder, so a change can be judged.

    Three configurations, not two, because the naive comparison is misleading.
    Swapping only the spread curve changes nothing at all on real data: books
    post moneylines on essentially every modern NFL game, so the moneyline rung
    takes precedence and the spread curve is never reached. Across 2015-2024 it
    fires twice in 5,246 team-weeks.

    So what is actually worth measuring is the engine as it was against the
    engine as it is — and the middle row separates the two changes, which is
    the only way to see which one did the work.

    Patched in place rather than kept as a second copy of the engine, because a
    second copy is the thing that drifts and then proves nothing.

    A stand-in still has to be callable the way the real one is, and that is
    the half that did drift: `resolve_team_win_probability` grew a devig method
    and a tie rule, the two replacements below kept their old two- and
    three-argument shapes, and every configuration here raised TypeError on the
    first priced game. `_same_shape` is why that cannot happen quietly again --
    it fails at the top of the run, naming the parameter that moved, rather
    than partway through a replay.
    """
    from models import win_prob

    def linear_spread(spread, team_is_home, tie_is_loss=win_prob.DEFAULT_TIE_IS_LOSS):
        # The rule as it was: no tie folded in, because there was none to fold.
        # `tie_is_loss` is accepted and ignored on purpose -- this is what the
        # engine did before, and reinstating the tie term here would make the
        # "before" row a thing that never shipped.
        if spread is None:
            return None
        home_favored_by = -spread
        favoured = home_favored_by if team_is_home else -home_favored_by
        return max(1.0, min(99.0, 50.0 + favoured * 1.2))

    def no_moneylines(home_moneyline, away_moneyline, team_is_home,
                      method=win_prob.DEFAULT_DEVIG_METHOD,
                      tie_is_loss=win_prob.DEFAULT_TIE_IS_LOSS):
        return None

    fitted_spread = win_prob.estimate_win_pct_from_spread
    real_moneylines = win_prob.win_pct_from_moneylines

    _same_shape(linear_spread, fitted_spread)
    _same_shape(no_moneylines, real_moneylines)

    configurations = (
        ("before: spread x 1.2, moneylines unread", linear_spread, no_moneylines),
        ("spread curve fitted, moneylines still unread", fitted_spread, no_moneylines),
        ("now: de-vigged moneyline, spread as fallback", fitted_spread, real_moneylines),
    )

    for label, spread_fn, moneyline_fn in configurations:
        win_prob.estimate_win_pct_from_spread = spread_fn
        win_prob.win_pct_from_moneylines = moneyline_fn
        print(f"\n== {label} " + "=" * max(0, 52 - len(label)))
        run(seasons, rows, names, verbose=False, starts=starts)

    win_prob.estimate_win_pct_from_spread = fitted_spread
    win_prob.win_pct_from_moneylines = real_moneylines


# Which options each report actually reads.
#
# A flag that does nothing is the same failure as the edge Function's ignored
# `maxAge`: nothing errors, the run looks right, and the numbers came from
# different settings than the command says they did. It is not hypothetical
# here -- deadpool/src/engine/measured.js records its run command, currently
# `--entries 2 --pot-share --synthetic 10000 --fields 25 --pairs ...`, as what
# produced the ratings the app prints, and `--pot-share` has never been read on
# the two-entry path: `--entries 2` returns before it is looked at. The numbers
# are right, and the record of how they were made was not.
#
# Deliberately not quoting that command in full any more. It was written out
# here as `--synthetic 2500` and went stale the moment the table was re-run at
# 10,000 -- the same drift this file warns about two paragraphs down, in a
# comment about drift. The flag is the point; the sample size is measured.js's
# to state.
#
# Warned rather than refused, on purpose. Erasing `--pot-share` from a
# published command would make that record wrong in the other direction, and a
# harness that dies over a redundant flag is worse than one that says so.
_READS: Dict[str, Set[str]] = {
    "robustness": {"seasons", "pairs", "fields", "synthetic", "jobs", "refresh", "robustness"},
    "holdings": {"seasons", "pairs", "fields", "synthetic", "jobs", "refresh", "entries"},
    "pot_share": {"seasons", "strategies", "fields", "refresh", "pot_share", "entries"},
    "compare": {"seasons", "strategies", "starts", "refresh", "compare_win_prob", "entries"},
    "weeks": {"seasons", "strategies", "starts", "verbose", "refresh", "entries"},
}


def _mode_of(args: argparse.Namespace) -> str:
    """The report `main` is about to run, in the order it decides."""
    if args.robustness:
        return "robustness"
    if args.entries == 2:
        return "holdings"
    if args.pot_share:
        return "pot_share"
    if args.compare_win_prob:
        return "compare"
    return "weeks"


def _warn_ignored(args: argparse.Namespace, defaults: argparse.Namespace, mode: str) -> List[str]:
    """Options set on the command line that this report will not read.

    Compared against the parser's own defaults rather than tracked by argparse,
    so passing a flag its default value is not reported -- that is a setting
    nobody is relying on.
    """
    reads = _READS[mode]
    ignored = sorted(
        name for name, value in vars(args).items()
        if name not in reads and value != getattr(defaults, name, None)
    )
    for name in ignored:
        print(f"warning: --{name.replace('_', '-')} is not read by this report ({mode}); it will have no effect",
              file=sys.stderr)
    return ignored


def build_parser() -> argparse.ArgumentParser:
    """The CLI, separately from running it, so the suite can ask it things.

    Same shape as main.py's, and for the same reason: a parser built inside
    main() can only be exercised by running the whole harness.
    """
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--seasons", type=int, nargs="+", default=list(range(2015, 2025)))
    parser.add_argument("--strategies", nargs="+", choices=sorted(STRATEGIES), default=sorted(STRATEGIES))
    parser.add_argument("--compare-win-prob", action="store_true", help="replay under the old spread rule as well")
    parser.add_argument("--pot-share", action="store_true",
                        help="score against a simulated 250-entry field, on the metric the pool pays")
    parser.add_argument("--fields", type=int, default=25, help="simulated fields per season for --pot-share")
    parser.add_argument("--field-tau", type=float, default=None, metavar="T",
                        help="how chalky the simulated field actually is; lower piles harder "
                             "onto the favourite. Defaults to CASUAL_TAU (0.35), which is what "
                             "every published run used. Unlike --robustness, which changes what "
                             "a strategy is TOLD, this changes what the field DOES.")
    parser.add_argument("--entries", type=int, default=1, choices=(1, 2),
                        help="replay two entries, which is what the traveller actually holds")
    parser.add_argument("--pairs", nargs="+", choices=sorted(PAIR_STRATEGIES),
                        default=sorted(PAIR_STRATEGIES), help="pair strategies, for --entries 2")
    parser.add_argument("--jobs", "-j", type=int, default=0, metavar="N",
                        help="processes to split the seasons across "
                             "(default: all cores but one; 1 disables)")
    parser.add_argument("--robustness", action="store_true",
                        help="how a pot-share strategy degrades when its view of the field is wrong")
    parser.add_argument("--synthetic", type=int, default=0, metavar="N",
                        help="replay N generated seasons instead of the real ones, "
                             "which is the only way to get power on a policy comparison")
    parser.add_argument("--refresh", action="store_true", help="re-download the results file")
    parser.add_argument("--starts", type=int, default=1,
                        help="also replay each season from weeks 2..N, for a larger sample")
    parser.add_argument("--verbose", action="store_true", help="print every pick")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    _warn_ignored(args, parser.parse_args([]), _mode_of(args))

    rows = load_rows(refresh=args.refresh)
    # Seasons are independent and each is deterministic, so this is exact.
    jobs = args.jobs if args.jobs > 0 else max(1, (os.cpu_count() or 1) - 1)

    if args.robustness:
        report_robustness(args.seasons, rows, args.pairs, fields=args.fields,
                          synthetic=args.synthetic or 200, jobs=jobs)
        return

    if args.entries == 2:
        report_holdings(args.seasons, rows, args.pairs, field_tau=args.field_tau, fields=args.fields,
                        synthetic=args.synthetic, jobs=jobs)
        return

    if args.pot_share:
        report_pot_share(args.seasons, rows, args.strategies, fields=args.fields)
        return

    if args.compare_win_prob:
        compare_win_prob(args.seasons, rows, args.strategies, starts=args.starts)
        return

    print(f"weeks survived, {len(args.seasons)} seasons, one entry, no repeats\n")
    run(args.seasons, rows, args.strategies, args.verbose, starts=args.starts)


if __name__ == "__main__":
    main()
