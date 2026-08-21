"""CLI for survivor-picker.

Output only -- this never submits a pick anywhere. You still make the pick
yourself in your pool's site/app, then optionally run `record-pick` so next
week's recommendations know that team is burned for that entry.

Usage:
    python main.py recommend [--week N] [--top N]
    python main.py record-pick --entry "Entry A" --team KC
    python main.py show-history
"""
from __future__ import annotations

import argparse
import logging
import sys

from config import CACHE_DIR, CACHE_TTL_HOURS, DEFAULT_SEASON_TYPE, ENTRIES
from data.espn_client import ESPNClient
from picker.recommender import find_conflicts, recommend_for_entries
from state.entries_store import load_used_teams, record_pick


def cmd_recommend(args: argparse.Namespace) -> None:
    client = ESPNClient(cache_dir=CACHE_DIR, cache_ttl_hours=CACHE_TTL_HOURS)
    games = client.get_week_games(week=args.week, seasontype=DEFAULT_SEASON_TYPE)
    if not games:
        print("No game data available (ESPN fetch failed and no cache on disk).")
        sys.exit(1)

    used_teams_by_entry = load_used_teams()
    recommendations = recommend_for_entries(games, used_teams_by_entry, top_n=args.top)

    week_label = games[0].week if games and games[0].week else "current"
    print(f"=== Survivor Picker recommendations (week {week_label}) ===\n")

    for entry in ENTRIES:
        candidates = recommendations.get(entry, [])
        print(f"-- {entry} (used: {', '.join(used_teams_by_entry.get(entry, [])) or 'none'}) --")
        if not candidates:
            print("  No eligible candidates (out of teams, or no data available).")
            continue
        for rank, c in enumerate(candidates, start=1):
            win_pct = f"{c.win_pct:.1f}%" if c.win_pct is not None else "unknown"
            est_flag = " (estimated from spread)" if c.win_pct_is_estimated else ""
            spread = f", spread: {c.spread_detail}" if c.spread_detail else ""
            print(
                f"  {rank}. {c.team_abbreviation} vs {c.opponent_abbreviation or '?'} "
                f"-- win prob {win_pct}{est_flag}{spread}"
            )
        print()

    conflict_team = find_conflicts(recommendations)
    if conflict_team:
        print(
            f"Heads up: both entries' top pick is {conflict_team}. "
            "Consider diversifying with the #2 option for one entry."
        )


def cmd_record_pick(args: argparse.Namespace) -> None:
    record_pick(args.entry, args.team.upper())
    print(f"Recorded {args.team.upper()} as used for {args.entry}.")


def cmd_show_history(_args: argparse.Namespace) -> None:
    used_teams_by_entry = load_used_teams()
    for entry, teams in used_teams_by_entry.items():
        print(f"{entry}: {', '.join(teams) if teams else '(no picks recorded yet)'}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="NFL survivor pool pick recommendations (output only).")
    parser.add_argument("--verbose", action="store_true", help="enable debug logging")
    subparsers = parser.add_subparsers(dest="command", required=True)

    recommend_parser = subparsers.add_parser("recommend", help="print ranked pick recommendations")
    recommend_parser.add_argument("--week", type=int, default=None, help="NFL week number (default: current)")
    recommend_parser.add_argument("--top", type=int, default=5, help="candidates to show per entry")
    recommend_parser.set_defaults(func=cmd_recommend)

    record_parser = subparsers.add_parser("record-pick", help="record a pick you already made elsewhere")
    record_parser.add_argument("--entry", required=True, choices=ENTRIES)
    record_parser.add_argument("--team", required=True, help="team abbreviation, e.g. KC")
    record_parser.set_defaults(func=cmd_record_pick)

    history_parser = subparsers.add_parser("show-history", help="show teams already used per entry")
    history_parser.set_defaults(func=cmd_show_history)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    args.func(args)


if __name__ == "__main__":
    main()
