"""Generates the weekly report as a static HTML page (for GitHub Pages).

This is the non-interactive counterpart to `main.py weekly`: it only
reads data and writes an HTML file -- it never prompts for confirmation
and never records a pick. It's meant to run unattended (e.g. a scheduled
GitHub Actions workflow) so the report is always up to date without
anyone running a command by hand.

Usage:
    python generate_report.py [--out docs/index.html] [--week N] [--lookahead-weeks N]
"""
from __future__ import annotations

import argparse
import logging
from pathlib import Path

from config import CACHE_DIR, CACHE_TTL_HOURS
from data.espn_client import ESPNClient
from report import (
    DEFAULT_HELD_BACK_LIMIT,
    DEFAULT_LOOKAHEAD_WEEKS,
    build_weekly_report,
    render_html,
)
from strategy.joint_optimizer import DEFAULT_MIN_WIN_PROB_FLOOR_B

DEFAULT_OUTPUT_PATH = Path(__file__).resolve().parent / "docs" / "index.html"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the weekly report as a static HTML page.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT_PATH, help="output HTML file path")
    parser.add_argument("--week", type=int, default=None, help="NFL week number (default: current)")
    parser.add_argument("--lookahead-weeks", type=int, default=DEFAULT_LOOKAHEAD_WEEKS)
    parser.add_argument("--min-win-prob-floor-b", type=float, default=DEFAULT_MIN_WIN_PROB_FLOOR_B)
    parser.add_argument("--held-back-limit", type=int, default=DEFAULT_HELD_BACK_LIMIT)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    client = ESPNClient(cache_dir=CACHE_DIR, cache_ttl_hours=CACHE_TTL_HOURS)
    report = build_weekly_report(
        client,
        week=args.week,
        lookahead_weeks=args.lookahead_weeks,
        min_win_prob_floor_b=args.min_win_prob_floor_b,
        held_back_limit=args.held_back_limit,
    )

    html = render_html(report)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(html, encoding="utf-8")
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
