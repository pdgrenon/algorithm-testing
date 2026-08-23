"""Read the pool's pick sheet and say what is in it.

Point this at a CSV exported from the Google Sheet -- File, Download,
Comma-separated values -- and it reports what the field has done, what every
entry has left, and anything in the sheet that cannot be true.

    python3 scripts/read-pool.py picks.csv
    python3 scripts/read-pool.py picks.csv --week 3      # one week in detail
    python3 scripts/read-pool.py picks.csv --entry "Gridiron Gang"

Reads a local file and nothing else, so unlike the other tools here it is safe
to run with no network at all.

── What it is for ──────────────────────────────────────────────────────────

Everything the engine currently believes about opponents is a prior. This is
the first thing that replaces belief with observation, and the two halves it
produces have very different standing:

**Inventories are exact.** After a week is visible you know precisely which
teams each surviving entry can no longer pick. Nothing is estimated.

**Popularity is observed for past weeks only.** Picks become visible after
kickoff, so the current week always has to be predicted. What past weeks buy is
the ability to fit that prediction against *this* field rather than against a
national average from pools with different people and different rules.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from data.pool_sheet import load_pool_sheet, used_teams_by_entry  # noqa: E402
from data.teams import NFL_TEAMS  # noqa: E402


def report(sheet, top: int = 8) -> None:
    alive = sheet.alive
    print(f"{len(sheet.entries)} entries, {len(alive)} still alive, "
          f"weeks 1-{max(sheet.weeks) if sheet.weeks else 0} recorded\n")

    if sheet.weeks:
        print(f"  {'week':>5} {'picked':>7} {'survived':>9} {'most popular':>28}")
        print("  " + "-" * 52)
        prev = len(sheet.entries)
        for week in sheet.weeks:
            pop = sheet.popularity(week)
            n = sum(1 for e in sheet.entries if week in e.picks)
            best = sorted(pop.items(), key=lambda kv: (-kv[1], kv[0]))[:2]
            label = ", ".join(f"{t} {100*s:.0f}%" for t, s in best)
            print(f"  {week:5} {n:7} {n/prev if prev else 0:9.0%} {label:>28}")
            prev = n or 1

    if alive:
        spent = Counter()
        for entry in alive:
            spent.update(entry.used)
        print(f"\n  what the surviving {len(alive)} have already spent:")
        for team, count in spent.most_common(top):
            print(f"    {team:4} gone for {count:3} of {len(alive)} ({100*count/len(alive):.0f}%)")

        # The number that matters most late: who is running out of room.
        thin = sorted(alive, key=lambda e: len(e.available()))[:5]
        print(f"\n  thinnest inventories:")
        for entry in thin:
            print(f"    {entry.entry_name[:32]:34} {len(entry.available())} teams left")

    if sheet.problems:
        print(f"\n  {len(sheet.problems)} thing(s) the sheet says that cannot be true:")
        for problem in sheet.problems[:20]:
            print(f"    - {problem}")
        if len(sheet.problems) > 20:
            print(f"    ... and {len(sheet.problems) - 20} more")
    else:
        print("\n  nothing in the sheet contradicts itself.")


def week_detail(sheet, week: int) -> None:
    pop = sheet.popularity(week)
    if not pop:
        print(f"nothing recorded for week {week}")
        return
    picked = sum(1 for e in sheet.entries if week in e.picks)
    print(f"week {week}: {picked} entries picked\n")
    print(f"  {'team':>5} {'share':>7} {'entries':>8}")
    for team, share in sorted(pop.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"  {team:>5} {100*share:6.1f}% {round(share*picked):8}")
    print(f"\n  {len(pop)} of 32 teams were taken by somebody; "
          f"the top pick held {100*max(pop.values()):.0f}% of the field.")


def entry_detail(sheet, name: str) -> None:
    match = [e for e in sheet.entries if e.entry_name.lower() == name.lower()]
    if not match:
        near = [e.entry_name for e in sheet.entries if name.lower() in e.entry_name.lower()]
        print(f"no entry called {name!r}" + (f"; did you mean {near[:5]}?" if near else ""))
        return
    entry = match[0]
    print(f"{entry.entry_name} -- {'alive' if entry.alive else 'out'}"
          f"{f' ({entry.status_text})' if entry.status_text else ''}\n")
    for week in sorted(entry.picks):
        print(f"  week {week:2}  {entry.picks[week]}")
    left = sorted(entry.available())
    print(f"\n  {len(left)} teams left: {' '.join(left)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("csv", help="the pool sheet, exported to CSV")
    parser.add_argument("--week", type=int, help="one week's popularity in detail")
    parser.add_argument("--entry", help="one entry's picks and remaining inventory")
    parser.add_argument("--strict", action="store_true",
                        help="stop on the first cell that will not resolve")
    args = parser.parse_args()

    sheet = load_pool_sheet(args.csv, strict=args.strict)
    if args.week:
        week_detail(sheet, args.week)
    elif args.entry:
        entry_detail(sheet, args.entry)
    else:
        report(sheet)


if __name__ == "__main__":
    main()
