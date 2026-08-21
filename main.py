"""CLI for survivor-picker.

Output only -- this never submits a pick anywhere. You still make the pick
yourself in your pool's site/app. `weekly` runs the full pipeline and, if
you confirm, records the picks it recommended; `record-pick` lets you
record something different (or by hand) at any time.

Usage:
    python main.py weekly [--week N] [--lookahead-weeks N] [--min-win-prob-floor-b PCT] [--yes]
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
from pick_history import build_combined_pick_history, format_result_text
from picker.recommender import find_conflicts, recommend_for_entries
from report import (
    DEFAULT_HELD_BACK_LIMIT,
    DEFAULT_LOOKAHEAD_WEEKS,
    build_weekly_report,
    render_text,
)
from state.entries_store import load_used_teams, record_pick
from strategy.joint_optimizer import DEFAULT_MIN_WIN_PROB_FLOOR_B, ENTRY_A_NAME, ENTRY_B_NAME


def _confirm(prompt: str) -> bool:
    try:
        answer = input(prompt)
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    return answer.strip().lower() in ("y", "yes")


def cmd_weekly(args: argparse.Namespace) -> None:
    client = ESPNClient(cache_dir=CACHE_DIR, cache_ttl_hours=CACHE_TTL_HOURS)

    report = build_weekly_report(
        client,
        week=args.week,
        lookahead_weeks=args.lookahead_weeks,
        min_win_prob_floor_b=args.min_win_prob_floor_b,
        held_back_limit=args.held_back_limit,
    )
    if report is None:
        print("No game data available (ESPN fetch failed and no cache on disk).")
        sys.exit(1)
    if not report.week_number_known:
        print("Warning: couldn't determine the current week number from ESPN; look-ahead data will be skipped.\n")

    print(render_text(report))

    joint_rec = report.joint_rec
    if joint_rec.pick_a is None or joint_rec.pick_b is None:
        print("\nNo confirmable pick pair this week -- nothing to record.")
        return

    confirmed = args.yes or _confirm(
        f"\nRecord Entry A -> {joint_rec.pick_a.team_abbreviation}, "
        f"Entry B -> {joint_rec.pick_b.team_abbreviation}? [y/N]: "
    )

    if confirmed:
        record_pick(ENTRY_A_NAME, joint_rec.pick_a.team_abbreviation, report.week)
        record_pick(ENTRY_B_NAME, joint_rec.pick_b.team_abbreviation, report.week)
        print(
            f"Recorded {joint_rec.pick_a.team_abbreviation} for Entry A and "
            f"{joint_rec.pick_b.team_abbreviation} for Entry B."
        )
    else:
        print("Picks not recorded. Re-run `weekly` once you've decided, or use `record-pick` manually.")


# -- other commands --------------------------------------------------------


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
    week = args.week
    if week is None:
        client = ESPNClient(cache_dir=CACHE_DIR, cache_ttl_hours=CACHE_TTL_HOURS)
        games = client.get_week_games(seasontype=DEFAULT_SEASON_TYPE, include_probability=False, include_odds=False)
        week = games[0].week if games and games[0].week else None
        if week is None:
            print("Warning: couldn't determine the current week from ESPN; recording with no week (pass --week to fix).")

    record_pick(args.entry, args.team.upper(), week)
    week_label = f"week {week}" if week is not None else "an unknown week"
    print(f"Recorded {args.team.upper()} as used for {args.entry} ({week_label}).")


def cmd_show_history(_args: argparse.Namespace) -> None:
    used_teams_by_entry = load_used_teams()
    for entry, teams in used_teams_by_entry.items():
        print(f"{entry}: {', '.join(teams) if teams else '(no picks recorded yet)'}")

    client = ESPNClient(cache_dir=CACHE_DIR, cache_ttl_hours=CACHE_TTL_HOURS)
    history = build_combined_pick_history(client)
    print()
    print("Pick history (win/loss):")
    if not history:
        print("  No picks recorded yet.")
    else:
        for row in history:
            print(f"  Week {row.week}: Entry A: {format_result_text(row.entry_a)} | Entry B: {format_result_text(row.entry_b)}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="NFL survivor pool pick recommendations (output only).")
    parser.add_argument("--verbose", action="store_true", help="enable debug logging")
    subparsers = parser.add_subparsers(dest="command", required=True)

    weekly_parser = subparsers.add_parser(
        "weekly", help="run the full pipeline: fetch, score, optimize, report, and (if confirmed) record"
    )
    weekly_parser.add_argument("--week", type=int, default=None, help="NFL week number (default: current)")
    weekly_parser.add_argument(
        "--lookahead-weeks",
        type=int,
        default=DEFAULT_LOOKAHEAD_WEEKS,
        help="how many weeks ahead to fetch and report on for held-back teams (default: 3)",
    )
    weekly_parser.add_argument(
        "--min-win-prob-floor-b",
        type=float,
        default=DEFAULT_MIN_WIN_PROB_FLOOR_B,
        help="minimum win probability (0-100) required for Entry B's pick (default: 65)",
    )
    weekly_parser.add_argument(
        "--held-back-limit", type=int, default=DEFAULT_HELD_BACK_LIMIT, help="max held-back teams to list"
    )
    weekly_parser.add_argument(
        "--yes", "-y", action="store_true", help="record the recommended picks without prompting for confirmation"
    )
    weekly_parser.set_defaults(func=cmd_weekly)

    recommend_parser = subparsers.add_parser("recommend", help="print ranked pick recommendations")
    recommend_parser.add_argument("--week", type=int, default=None, help="NFL week number (default: current)")
    recommend_parser.add_argument("--top", type=int, default=5, help="candidates to show per entry")
    recommend_parser.set_defaults(func=cmd_recommend)

    record_parser = subparsers.add_parser("record-pick", help="record a pick you already made elsewhere")
    record_parser.add_argument("--entry", required=True, choices=ENTRIES)
    record_parser.add_argument("--team", required=True, help="team abbreviation, e.g. KC")
    record_parser.add_argument(
        "--week", type=int, default=None, help="NFL week number (default: current, auto-detected from ESPN)"
    )
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
