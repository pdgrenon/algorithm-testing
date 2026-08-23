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
loses. A tie counts as a win, matching `CONFIG` in the app. The number reported
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
import sys
import urllib.request
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from data.models import Game, Odds, Team  # noqa: E402
from models.win_prob import build_win_probability_table  # noqa: E402
from picker import recommender  # noqa: E402
from strategy import entry_a_value, entry_b_hedge, joint_optimizer  # noqa: E402

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

    A tie is a win, matching the app's default. A game with no final score is
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


STRATEGIES: Dict[str, Callable] = {
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
    parser.add_argument("--refresh", action="store_true", help="re-download the results file")
    parser.add_argument("--starts", type=int, default=1,
                        help="also replay each season from weeks 2..N, for a larger sample")
    parser.add_argument("--verbose", action="store_true", help="print every pick")
    args = parser.parse_args()

    rows = load_rows(refresh=args.refresh)

    if args.compare_win_prob:
        compare_win_prob(args.seasons, rows, args.strategies, starts=args.starts)
        return

    print(f"weeks survived, {len(args.seasons)} seasons, one entry, no repeats\n")
    run(args.seasons, rows, args.strategies, args.verbose, starts=args.starts)


if __name__ == "__main__":
    main()
