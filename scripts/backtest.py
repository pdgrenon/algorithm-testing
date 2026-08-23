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
import random
import sys
import urllib.request
from pathlib import Path
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
from strategy import entry_a_value, entry_b_hedge, joint_optimizer, sequence_dp  # noqa: E402

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
        mine, best, tied = [], [], 0
        for season in seasons:
            by_week = games_for_season(rows, season)
            outcomes = outcome_for(rows, season)
            table = build_win_probability_table(
                [g for w in sorted(by_week) for g in by_week[w]]
            )
            for seed in range(fields):
                depth, field_best = _one_field(by_week, outcomes, table, STRATEGIES[name], seed)
                mine.append(depth)
                best.append(field_best)
                tied += depth == field_best
        n = len(mine)
        print(f"    {name:10} {sum(mine)/n:11.2f} {sum(best)/n:11.2f} "
              f"{tied:8}/{n} {tied/n/max(1, 1):11.5f}")

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
    """One season against one field. Returns (your depth, the field's best)."""
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

    return (
        pool["me"].last_week_survived,
        max(o.last_week_survived for k, o in pool.items() if k != "me"),
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


def pair_twice(single: Callable) -> Callable:
    """Run a single-entry strategy once per entry, independently.

    The honest baseline, and a bad holding: the strategy is deterministic and
    both entries start with the same empty inventory, so they pick the same
    team every week until one of them dies. Two perfectly correlated entries
    are one entry that cost twice as much, which is exactly the thing a pair
    search has to beat to be worth having.
    """
    def pick(games, table, week, used_lists, context):
        return [single(games, table, week, used) for used in used_lists]
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
        picks: List[Optional[str]] = []
        taken: List[str] = []
        for used in used_lists:
            choice = single(games, table, week, list(used) + taken)
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
        return [pick_sequence(games, table, week, used_lists[0])]
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
    if any(not inv for inv in inventories):
        return [None] * len(used_lists)
    best = rank_holdings(board, inventories, context["terminal_field"], limit=1)
    return list(best[0].teams) if best else [None] * len(used_lists)


PAIR_STRATEGIES: Dict[str, Callable] = {
    "potshare": pair_pot_share,
    "joint": pair_joint,
    "distinct": pair_distinct(pick_sequence),
    "twice": pair_twice(pick_sequence),
}


def _one_field_holding(by_week, outcomes, table, pick_pair, seed: int, entries: int = 2):
    """One season, one holding of `entries`, against one simulated field.

    Returns (your pot share, your deepest entry, the field's deepest).
    """
    rng = random.Random(seed)
    my_ids = [f"me{i}" for i in range(entries)]
    pool = field_model.build_field(DEFAULT_POOL_SIZE, my_ids)
    used_lists: List[List[str]] = [[] for _ in my_ids]
    twinned = weeks_both_picked = 0

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

        living = [i for i, entry_id in enumerate(my_ids) if pool[entry_id].alive]
        if living:
            opponents_alive = sum(
                1 for k, o in pool.items() if k not in my_ids and o.alive
            )
            context = {
                "popularity": field_model.popularity_forecast(pool, candidates, exclude=my_ids),
                "terminal_field": field_model.terminal_field(opponents_alive, week),
                "opponents_alive": opponents_alive,
                "week": week,
            }
            picks = pick_pair(
                by_week[week], table, week, [used_lists[i] for i in living], context
            )
            if len(living) == entries and all(picks):
                weeks_both_picked += 1
                if len(set(picks)) == 1:
                    twinned += 1
            for slot, team in zip(living, picks):
                entry = pool[my_ids[slot]]
                if team is None:
                    entry.alive = False
                    continue
                used_lists[slot].append(team)
                entry.used.add(team)
                if outcomes.get((week, team)) == "win":
                    entry.last_week_survived = week
                else:
                    entry.alive = False

        for entry_id, opponent in pool.items():
            if entry_id not in my_ids:
                field_model.advance(opponent, candidates, outcomes, week, rng)

        if not any(o.alive for o in pool.values()):
            break

    depths = {k: o.last_week_survived for k, o in pool.items()}
    return (
        pot_share(depths, my_ids),
        max(depths[k] for k in my_ids),
        max(o.last_week_survived for k, o in pool.items() if k not in my_ids),
        twinned,
        weeks_both_picked,
    )



def seasons_to_replay(
    seasons: List[int], rows: List[dict], synthetic: int = 0
) -> List[Tuple[object, Dict[int, List[Game]], Dict[Tuple[int, str], str]]]:
    """Every season to replay, as (label, slate by week, outcomes).

    One list whether the seasons are real or generated, so the reports have a
    single code path and cannot drift between the two. See scripts/synth.py
    for why the generated ones exist: ten real seasons cannot separate these
    strategies, and there will never be an eleventh.
    """
    if synthetic:
        out = []
        for i in range(synthetic):
            by_week, outcomes, _ = synth.season(i)
            out.append((i, by_week, outcomes))
        return out
    out = []
    for season in seasons:
        by_week = games_for_season(rows, season)
        if by_week:
            out.append((season, by_week, outcome_for(rows, season)))
    return out


def report_holdings(
    seasons: List[int], rows: List[dict], names: List[str],
    fields: int = 25, synthetic: int = 0,
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

    ── Which is what --synthetic is for ────────────────────────────────────

    Ten seasons of a metric that is zero 80% of the time cannot separate four
    strategies, and there will never be an eleventh. `--synthetic N` replays N
    generated seasons instead, fitted to the real distribution and with the
    true probabilities handed to every strategy, so a gap between two of them
    is a policy difference rather than one having a better read on the games.
    See scripts/synth.py. At that point the mean is worth reading and a
    standard error is printed beside it.
    """
    replay = seasons_to_replay(seasons, rows, synthetic)
    if not replay:
        print("no seasons to replay")
        return

    label = f"{len(replay)} synthetic seasons" if synthetic else f"{len(replay)} seasons"
    print(f"two entries, {DEFAULT_POOL_SIZE}-entry pool, {fields} simulated fields "
          f"per season, {label}\n")
    print(f"  {'strategy':<10} {'pot share':>10} {'± se':>8} {'x fair':>8} {'$ back':>8} "
          f"{'deepest':>8} {'field':>7} {'paid':>6} {'same pick':>10}")
    print("  " + "-" * 83)

    fair = 2.0 / DEFAULT_POOL_SIZE
    by_season: Dict[str, Dict[object, float]] = {}
    for name in names:
        pick_pair = PAIR_STRATEGIES[name]
        shares, mine, theirs, wins = [], [], [], 0
        same = total = 0
        by_season[name] = {}
        for tag, by_week, outcomes in replay:
            table = build_win_probability_table(
                [g for w in sorted(by_week) for g in by_week[w]]
            )
            season_shares = []
            for k in range(fields):
                share, best, field_best, twin, picks = _one_field_holding(
                    by_week, outcomes, table, pick_pair, seed=hash((tag, k)) & 0xFFFF
                )
                shares.append(share)
                season_shares.append(share)
                mine.append(best)
                theirs.append(field_best)
                same += twin
                total += picks
                if share > 0:
                    wins += 1
            by_season[name][tag] = sum(season_shares) / len(season_shares)
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

    if not synthetic:
        print(f"\n  the same numbers by season, which is where the sample actually is:\n")
        print("  " + " " * 10 + "".join(f"{t:>8}" for t, _, _ in replay))
        for name in names:
            row = "".join(f"{by_season[name].get(t, 0.0):8.3f}" for t, _, _ in replay)
            print(f"  {name:<10}{row}")
        live = [t for t, _, _ in replay if any(by_season[n].get(t) for n in names)]
        print(f"\n  seasons that paid anything at all: "
              f"{', '.join(str(s) for s in live) or 'none'} of {len(replay)}.")

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


def _standard_error(values: List[float]) -> float:
    """Standard error of the mean. Zero for a single observation, honestly."""
    n = len(values)
    if n < 2:
        return 0.0
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / (n - 1)
    return (var / n) ** 0.5


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
    """
    from models import win_prob

    def linear_spread(spread, team_is_home):
        if spread is None:
            return None
        home_favored_by = -spread
        favoured = home_favored_by if team_is_home else -home_favored_by
        return max(1.0, min(99.0, 50.0 + favoured * 1.2))

    def no_moneylines(home_ml, away_ml, team_is_home):
        return None

    fitted_spread = win_prob.estimate_win_pct_from_spread
    real_moneylines = win_prob.win_pct_from_moneylines

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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--seasons", type=int, nargs="+", default=list(range(2015, 2025)))
    parser.add_argument("--strategies", nargs="+", choices=sorted(STRATEGIES), default=sorted(STRATEGIES))
    parser.add_argument("--compare-win-prob", action="store_true", help="replay under the old spread rule as well")
    parser.add_argument("--pot-share", action="store_true",
                        help="score against a simulated 250-entry field, on the metric the pool pays")
    parser.add_argument("--fields", type=int, default=25, help="simulated fields per season for --pot-share")
    parser.add_argument("--entries", type=int, default=1, choices=(1, 2),
                        help="replay two entries, which is what the traveller actually holds")
    parser.add_argument("--pairs", nargs="+", choices=sorted(PAIR_STRATEGIES),
                        default=sorted(PAIR_STRATEGIES), help="pair strategies, for --entries 2")
    parser.add_argument("--synthetic", type=int, default=0, metavar="N",
                        help="replay N generated seasons instead of the real ones, "
                             "which is the only way to get power on a policy comparison")
    parser.add_argument("--refresh", action="store_true", help="re-download the results file")
    parser.add_argument("--starts", type=int, default=1,
                        help="also replay each season from weeks 2..N, for a larger sample")
    parser.add_argument("--verbose", action="store_true", help="print every pick")
    args = parser.parse_args()

    rows = load_rows(refresh=args.refresh)

    if args.entries == 2:
        report_holdings(args.seasons, rows, args.pairs, fields=args.fields,
                        synthetic=args.synthetic)
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
