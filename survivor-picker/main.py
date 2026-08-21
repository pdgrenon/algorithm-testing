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
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

from config import CACHE_DIR, CACHE_TTL_HOURS, DEFAULT_SEASON_TYPE, ENTRIES
from data.espn_client import ESPNClient
from data.models import Game
from data.teams import NFL_TEAMS
from models.future_value import compute_future_value
from models.win_prob import TeamWeekWinProbability, build_win_probability_table
from picker.recommender import find_conflicts, recommend_for_entries
from state.entries_store import load_used_teams, load_used_teams_for_entry, record_pick
from strategy.joint_optimizer import (
    DEFAULT_MIN_WIN_PROB_FLOOR_B,
    ENTRY_A_NAME,
    ENTRY_B_NAME,
    TeamOption,
)
from strategy.joint_optimizer import recommend as recommend_joint

DEFAULT_LOOKAHEAD_WEEKS = 3
DEFAULT_HELD_BACK_LIMIT = 10


# -- weekly pipeline -----------------------------------------------------


@dataclass
class HeldBackTeam:
    team_abbreviation: str
    this_week_win_pct: Optional[float]
    best_future_week: Optional[int]
    best_future_win_pct: Optional[float]
    future_value: Optional[float]


def _fetch_pipeline_games(
    client: ESPNClient, week: Optional[int], lookahead_weeks: int
) -> Tuple[Optional[int], List[Game], List[Game]]:
    """Fetch this week's games plus the next ``lookahead_weeks`` weeks.

    Returns ``(current_week_number, current_week_games, all_games)``.
    ``current_week_number`` is ``None`` if ESPN's response didn't include a
    week number and the caller didn't pin one down with ``--week`` -- in
    that case the look-ahead fetch is skipped entirely since there's no way
    to know which weeks to ask for.
    """
    current_week_games = client.get_week_games(week=week, seasontype=DEFAULT_SEASON_TYPE)
    if not current_week_games:
        return None, [], []

    current_week_number = week if week is not None else current_week_games[0].week

    all_games = list(current_week_games)
    if current_week_number is not None:
        for offset in range(1, lookahead_weeks + 1):
            all_games.extend(
                client.get_week_games(week=current_week_number + offset, seasontype=DEFAULT_SEASON_TYPE)
            )

    return current_week_number, current_week_games, all_games


def _remaining_pool(used_teams: List[str]) -> List[str]:
    used = set(used_teams)
    return [team for team in NFL_TEAMS if team not in used]


def compute_held_back_teams(
    current_week_games: List[Game],
    win_prob_table: Dict[Tuple[str, int], TeamWeekWinProbability],
    current_week: int,
    used_teams_a: List[str],
    used_teams_b: List[str],
    picked_teams: Set[str],
    lookahead_weeks: int = DEFAULT_LOOKAHEAD_WEEKS,
) -> List[HeldBackTeam]:
    """Teams playing this week, available to at least one entry, that
    aren't this week's recommended picks, and for which the model actually
    projects a better matchup within ``lookahead_weeks`` -- i.e. teams
    worth holding back on purpose, not just everyone left over.
    """
    this_week_table = build_win_probability_table(current_week_games)
    seen: Set[str] = set()
    held_back: List[HeldBackTeam] = []

    for game in current_week_games:
        if game.state and game.state != "pre":
            continue
        for team in (game.home, game.away):
            abbr = team.abbreviation
            if not abbr or abbr in seen:
                continue
            seen.add(abbr)

            if abbr in picked_teams:
                continue
            if abbr in used_teams_a and abbr in used_teams_b:
                continue  # fully burned already -- nothing left to hold

            this_week_entry = this_week_table.get((abbr, current_week))
            this_week_win_pct = this_week_entry.win_pct if this_week_entry else None

            remaining_schedule = [
                entry for (t, wk), entry in win_prob_table.items() if t == abbr and wk > current_week
            ]
            future = compute_future_value(
                abbr, current_week, this_week_win_pct, remaining_schedule, lookahead_weeks=lookahead_weeks
            )
            if future.should_hold:
                held_back.append(
                    HeldBackTeam(
                        team_abbreviation=abbr,
                        this_week_win_pct=this_week_win_pct,
                        best_future_week=future.best_future_week,
                        best_future_win_pct=future.best_future_win_pct,
                        future_value=future.future_value,
                    )
                )

    held_back.sort(key=lambda h: -(h.future_value or 0))
    return held_back


def _describe_option(option: TeamOption) -> str:
    win_pct = f"{option.win_pct:.1f}%" if option.win_pct is not None else "unknown"
    basis = " (estimated from spread)" if option.win_pct_source == "spread_estimate" else ""
    spread = f", spread {option.spread_detail}" if option.spread_detail else ""
    return f"{option.team_abbreviation} vs {option.opponent_abbreviation or '?'} -- {win_pct} win prob{basis}{spread}"


def _print_weekly_report(joint_rec, used_teams_a, used_teams_b, held_back, lookahead_weeks: int) -> None:
    week_label = joint_rec.week or "unknown"
    print(f"=== Survivor Picker Weekly Report -- Week {week_label} ===\n")

    print("RECOMMENDED PICKS (joint optimizer)")
    if joint_rec.pick_a is not None and joint_rec.pick_b is not None:
        print(f"  Entry A: {_describe_option(joint_rec.pick_a)}")
        print(f"  Entry B: {_describe_option(joint_rec.pick_b)}")
        print(
            f"  Outcomes this week -- both survive: {joint_rec.both_survive_pct:.1f}% | "
            f"one survives: {joint_rec.one_survives_pct:.1f}% | "
            f"both eliminated: {joint_rec.both_eliminated_pct:.1f}%"
        )
    else:
        print("  No valid pick pair available this week.")
    print(f"  Reasoning: {joint_rec.reasoning}")
    print()

    print("REMAINING TEAMS POOL")
    remaining_a = _remaining_pool(used_teams_a)
    remaining_b = _remaining_pool(used_teams_b)
    print(f"  Entry A ({len(remaining_a)} remaining): {', '.join(remaining_a)}")
    print(f"  Entry B ({len(remaining_b)} remaining): {', '.join(remaining_b)}")
    print()

    print(f"HOLDING BACK -- BEST MATCHUPS IN THE NEXT {lookahead_weeks} WEEKS")
    if not held_back:
        print("  No held-back team currently projects a better matchup than this week (or no forward data yet).")
    else:
        for h in held_back:
            this_week = f"{h.this_week_win_pct:.1f}%" if h.this_week_win_pct is not None else "unknown"
            future = f"{h.best_future_win_pct:.1f}%" if h.best_future_win_pct is not None else "unknown"
            delta = f"+{h.future_value:.1f}" if h.future_value is not None else "n/a"
            print(
                f"  {h.team_abbreviation}: week {h.best_future_week} looks best at {future} "
                f"(this week: {this_week}, future value {delta})"
            )


def _confirm(prompt: str) -> bool:
    try:
        answer = input(prompt)
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    return answer.strip().lower() in ("y", "yes")


def cmd_weekly(args: argparse.Namespace) -> None:
    client = ESPNClient(cache_dir=CACHE_DIR, cache_ttl_hours=CACHE_TTL_HOURS)

    current_week, current_week_games, all_games = _fetch_pipeline_games(
        client, args.week, args.lookahead_weeks
    )
    if not current_week_games:
        print("No game data available (ESPN fetch failed and no cache on disk).")
        sys.exit(1)
    if current_week is None:
        print("Warning: couldn't determine the current week number from ESPN; look-ahead data will be skipped.\n")

    win_prob_table = build_win_probability_table(all_games)

    used_teams_a = load_used_teams_for_entry(ENTRY_A_NAME)
    used_teams_b = load_used_teams_for_entry(ENTRY_B_NAME)

    joint_rec = recommend_joint(
        current_week_games,
        current_week or 0,
        used_teams_a=used_teams_a,
        used_teams_b=used_teams_b,
        min_win_prob_floor_b=args.min_win_prob_floor_b,
    )

    picked_teams = {p.team_abbreviation for p in (joint_rec.pick_a, joint_rec.pick_b) if p is not None}
    held_back: List[HeldBackTeam] = []
    if current_week is not None:
        held_back = compute_held_back_teams(
            current_week_games,
            win_prob_table,
            current_week,
            used_teams_a,
            used_teams_b,
            picked_teams,
            args.lookahead_weeks,
        )[: args.held_back_limit]

    _print_weekly_report(joint_rec, used_teams_a, used_teams_b, held_back, args.lookahead_weeks)

    if joint_rec.pick_a is None or joint_rec.pick_b is None:
        print("\nNo confirmable pick pair this week -- nothing to record.")
        return

    confirmed = args.yes or _confirm(
        f"\nRecord Entry A -> {joint_rec.pick_a.team_abbreviation}, "
        f"Entry B -> {joint_rec.pick_b.team_abbreviation}? [y/N]: "
    )

    if confirmed:
        record_pick(ENTRY_A_NAME, joint_rec.pick_a.team_abbreviation)
        record_pick(ENTRY_B_NAME, joint_rec.pick_b.team_abbreviation)
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
