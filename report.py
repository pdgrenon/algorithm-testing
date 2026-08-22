"""Builds the weekly report's data, and renders it as text or HTML.

Shared between main.py's interactive `weekly` command (terminal output)
and generate_report.py (a static HTML page, generated on demand) so the
two never drift apart -- both call ``build_weekly_report()`` for the data,
then pick a renderer. Building the report never writes any state (no
picks are recorded here); that only happens in main.py's `weekly` command,
after a human confirms.
"""
from __future__ import annotations

import html as html_lib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set, Tuple

from data.espn_client import ESPNClient
from data.models import Game
from data.teams import NFL_TEAMS
from models.future_value import compute_future_value
from models.win_prob import TeamWeekWinProbability, build_win_probability_table
from pick_history import RESULT_LABELS, HistoryRow, PickResult, build_combined_pick_history, format_result_text
from state.entries_store import load_used_teams_for_entry
from strategy.joint_optimizer import (
    DEFAULT_MIN_WIN_PROB_FLOOR_B,
    ENTRY_A_NAME,
    ENTRY_B_NAME,
    JointRecommendation,
    TeamOption,
)
from strategy.joint_optimizer import recommend as recommend_joint

DEFAULT_LOOKAHEAD_WEEKS = 3
DEFAULT_HELD_BACK_LIMIT = 10
DEFAULT_SEASON_TYPE = 2  # ESPN: 1 = preseason, 2 = regular season, 3 = postseason


@dataclass
class HeldBackTeam:
    team_abbreviation: str
    this_week_win_pct: Optional[float]
    best_future_week: Optional[int]
    best_future_win_pct: Optional[float]
    future_value: Optional[float]


@dataclass
class WeeklyReport:
    week: Optional[int]
    joint_rec: JointRecommendation
    used_teams_a: List[str]
    used_teams_b: List[str]
    remaining_a: List[str]
    remaining_b: List[str]
    held_back: List[HeldBackTeam]
    lookahead_weeks: int
    week_number_known: bool
    pick_history: List[HistoryRow] = field(default_factory=list)
    generated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


def fetch_pipeline_games(
    client: ESPNClient, week: Optional[int], lookahead_weeks: int
) -> Tuple[Optional[int], List[Game], List[Game]]:
    """Fetch this week's games plus the next ``lookahead_weeks`` weeks.

    Returns ``(current_week_number, current_week_games, all_games)``.
    ``current_week_number`` is ``None`` if ESPN's response didn't include a
    week number and the caller didn't pin one down with ``week`` -- in that
    case the look-ahead fetch is skipped since there's no way to know which
    weeks to ask for.
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


def remaining_pool(used_teams: List[str]) -> List[str]:
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


def build_weekly_report(
    client: ESPNClient,
    week: Optional[int] = None,
    lookahead_weeks: int = DEFAULT_LOOKAHEAD_WEEKS,
    min_win_prob_floor_b: float = DEFAULT_MIN_WIN_PROB_FLOOR_B,
    held_back_limit: int = DEFAULT_HELD_BACK_LIMIT,
) -> Optional[WeeklyReport]:
    """Run the full read-only pipeline: fetch, score, optimize. Returns
    ``None`` if no game data could be obtained at all (fetch failed and no
    cache on disk). Never writes any state.
    """
    current_week, current_week_games, all_games = fetch_pipeline_games(client, week, lookahead_weeks)
    if not current_week_games:
        return None

    win_prob_table = build_win_probability_table(all_games)

    used_teams_a = load_used_teams_for_entry(ENTRY_A_NAME)
    used_teams_b = load_used_teams_for_entry(ENTRY_B_NAME)

    joint_rec = recommend_joint(
        current_week_games,
        current_week or 0,
        used_teams_a=used_teams_a,
        used_teams_b=used_teams_b,
        min_win_prob_floor_b=min_win_prob_floor_b,
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
            lookahead_weeks,
        )[:held_back_limit]

    return WeeklyReport(
        week=current_week,
        joint_rec=joint_rec,
        used_teams_a=used_teams_a,
        used_teams_b=used_teams_b,
        remaining_a=remaining_pool(used_teams_a),
        remaining_b=remaining_pool(used_teams_b),
        held_back=held_back,
        lookahead_weeks=lookahead_weeks,
        week_number_known=current_week is not None,
        pick_history=build_combined_pick_history(client),
    )


def describe_option(option: TeamOption) -> str:
    win_pct = f"{option.win_pct:.1f}%" if option.win_pct is not None else "unknown"
    basis = " (estimated from spread)" if option.win_pct_source == "spread_estimate" else ""
    spread = f", spread {option.spread_detail}" if option.spread_detail else ""
    return f"{option.team_abbreviation} vs {option.opponent_abbreviation or '?'} -- {win_pct} win prob{basis}{spread}"


def render_text(report: WeeklyReport) -> str:
    lines = []
    week_label = report.week or "unknown"
    lines.append(f"=== Survivor Picker Weekly Report -- Week {week_label} ===\n")

    lines.append("RECOMMENDED PICKS (joint optimizer)")
    joint_rec = report.joint_rec
    if joint_rec.pick_a is not None and joint_rec.pick_b is not None:
        lines.append(f"  Entry A: {describe_option(joint_rec.pick_a)}")
        lines.append(f"  Entry B: {describe_option(joint_rec.pick_b)}")
        lines.append(
            f"  Outcomes this week -- both survive: {joint_rec.both_survive_pct:.1f}% | "
            f"one survives: {joint_rec.one_survives_pct:.1f}% | "
            f"both eliminated: {joint_rec.both_eliminated_pct:.1f}%"
        )
    else:
        lines.append("  No valid pick pair available this week.")
    lines.append(f"  Reasoning: {joint_rec.reasoning}")
    lines.append("")

    lines.append("REMAINING TEAMS POOL")
    lines.append(f"  Entry A ({len(report.remaining_a)} remaining): {', '.join(report.remaining_a)}")
    lines.append(f"  Entry B ({len(report.remaining_b)} remaining): {', '.join(report.remaining_b)}")
    lines.append("")

    lines.append(f"HOLDING BACK -- BEST MATCHUPS IN THE NEXT {report.lookahead_weeks} WEEKS")
    if not report.held_back:
        lines.append("  No held-back team currently projects a better matchup than this week (or no forward data yet).")
    else:
        for h in report.held_back:
            this_week = f"{h.this_week_win_pct:.1f}%" if h.this_week_win_pct is not None else "unknown"
            future = f"{h.best_future_win_pct:.1f}%" if h.best_future_win_pct is not None else "unknown"
            delta = f"+{h.future_value:.1f}" if h.future_value is not None else "n/a"
            lines.append(
                f"  {h.team_abbreviation}: week {h.best_future_week} looks best at {future} "
                f"(this week: {this_week}, future value {delta})"
            )
    lines.append("")

    lines.append("PICK HISTORY")
    if not report.pick_history:
        lines.append("  No picks recorded yet.")
    else:
        for row in report.pick_history:
            lines.append(
                f"  Week {row.week}: Entry A: {format_result_text(row.entry_a)} | "
                f"Entry B: {format_result_text(row.entry_b)}"
            )

    return "\n".join(lines)


def _esc(text: object) -> str:
    return html_lib.escape(str(text))


def _pick_card_html(entry_name: str, pick: Optional[TeamOption]) -> str:
    if pick is None:
        return f"""
        <div class="pick-card">
          <h3>{_esc(entry_name)}</h3>
          <p class="none">No valid pick available.</p>
        </div>"""
    win_pct = f"{pick.win_pct:.1f}%" if pick.win_pct is not None else "unknown"
    basis = " <span class=\"estimated\">(estimated from spread)</span>" if pick.win_pct_source == "spread_estimate" else ""
    spread = f"<div class=\"spread\">Spread: {_esc(pick.spread_detail)}</div>" if pick.spread_detail else ""
    return f"""
        <div class="pick-card">
          <h3>{_esc(entry_name)}</h3>
          <div class="team">{_esc(pick.team_abbreviation)}</div>
          <div class="opponent">vs {_esc(pick.opponent_abbreviation or '?')}</div>
          <div class="winpct">{_esc(win_pct)} win probability{basis}</div>
          {spread}
        </div>"""


_RESULT_CLASSES = {"win": "result-win", "loss": "result-loss", "tie": "result-tie"}


def _pick_result_cell_html(pr: Optional[PickResult]) -> str:
    if pr is None:
        return '<td class="none">-</td>'
    label = RESULT_LABELS.get(pr.result, "?")
    css_class = _RESULT_CLASSES.get(pr.result, "")
    score = ""
    if pr.result in ("win", "loss", "tie") and pr.team_score is not None and pr.opponent_score is not None:
        score = f" {pr.team_score}-{pr.opponent_score}"
    opponent = f" vs {_esc(pr.opponent)}" if pr.opponent else ""
    return f'<td><span class="team-cell">{_esc(pr.team)}</span> <span class="{css_class}">{_esc(label)}{_esc(score)}</span>{opponent}</td>'


def _record_tally(history: List[HistoryRow], side: str) -> str:
    wins = losses = ties = 0
    for row in history:
        pr = getattr(row, side)
        if pr is None:
            continue
        if pr.result == "win":
            wins += 1
        elif pr.result == "loss":
            losses += 1
        elif pr.result == "tie":
            ties += 1
    return f"{wins}-{losses}-{ties}" if ties else f"{wins}-{losses}"


def render_html(report: Optional[WeeklyReport], title: str = "Survivor Picker Weekly Report") -> str:
    """A self-contained, non-technical-friendly HTML page for the report."""
    generated_at = (report.generated_at if report else datetime.now(timezone.utc)).strftime("%B %d, %Y at %H:%M UTC")

    if report is None:
        body = """
        <p class="none">No game data was available when this report last ran
        (ESPN fetch failed and there was no cache to fall back to). This page
        will update the next time the report runs successfully.</p>"""
    else:
        joint_rec = report.joint_rec
        week_label = report.week if report.week else "unknown"

        outcomes_html = ""
        picks_html = _pick_card_html("Entry A", joint_rec.pick_a) + _pick_card_html("Entry B", joint_rec.pick_b)
        if joint_rec.pick_a is not None and joint_rec.pick_b is not None:
            outcomes_html = f"""
        <div class="outcomes">
          <div class="outcome"><span class="value">{joint_rec.both_survive_pct:.1f}%</span><span class="label">Both survive</span></div>
          <div class="outcome"><span class="value">{joint_rec.one_survives_pct:.1f}%</span><span class="label">One survives</span></div>
          <div class="outcome"><span class="value">{joint_rec.both_eliminated_pct:.1f}%</span><span class="label">Both eliminated</span></div>
        </div>"""

        remaining_html = f"""
        <div class="pool">
          <h3>Entry A <span class="count">({len(report.remaining_a)} remaining)</span></h3>
          <p class="teams">{_esc(', '.join(report.remaining_a)) or '(none left)'}</p>
        </div>
        <div class="pool">
          <h3>Entry B <span class="count">({len(report.remaining_b)} remaining)</span></h3>
          <p class="teams">{_esc(', '.join(report.remaining_b)) or '(none left)'}</p>
        </div>"""

        if not report.held_back:
            held_back_html = '<p class="none">No held-back team currently projects a better matchup than this week (or no forward data yet).</p>'
        else:
            rows = "".join(
                f"""
              <tr>
                <td class="team-cell">{_esc(h.team_abbreviation)}</td>
                <td>Week {_esc(h.best_future_week)}</td>
                <td>{_esc(f"{h.best_future_win_pct:.1f}%") if h.best_future_win_pct is not None else "unknown"}</td>
                <td>{_esc(f"{h.this_week_win_pct:.1f}%") if h.this_week_win_pct is not None else "unknown"}</td>
                <td class="positive">{_esc(f"+{h.future_value:.1f}") if h.future_value is not None else "n/a"}</td>
              </tr>"""
                for h in report.held_back
            )
            held_back_html = f"""
            <table>
              <thead>
                <tr><th>Team</th><th>Best week</th><th>Best matchup win %</th><th>This week win %</th><th>Future value</th></tr>
              </thead>
              <tbody>{rows}
              </tbody>
            </table>"""

        if not report.pick_history:
            history_html = '<p class="none">No picks recorded yet.</p>'
        else:
            record_a = _record_tally(report.pick_history, "entry_a")
            record_b = _record_tally(report.pick_history, "entry_b")
            history_rows = "".join(
                f"""
              <tr>
                <td>Week {_esc(row.week)}</td>
                {_pick_result_cell_html(row.entry_a)}
                {_pick_result_cell_html(row.entry_b)}
              </tr>"""
                for row in report.pick_history
            )
            history_html = f"""
            <p class="records">Entry A record: <strong>{_esc(record_a)}</strong> &nbsp;&nbsp; Entry B record: <strong>{_esc(record_b)}</strong></p>
            <table>
              <thead>
                <tr><th>Week</th><th>Entry A</th><th>Entry B</th></tr>
              </thead>
              <tbody>{history_rows}
              </tbody>
            </table>"""

        body = f"""
        <section>
          <h2>Week {_esc(week_label)} recommended picks</h2>
          <div class="picks">{picks_html}
          </div>
          {outcomes_html}
          <p class="reasoning">{_esc(joint_rec.reasoning)}</p>
        </section>

        <section>
          <h2>Remaining teams pool</h2>
          <div class="pools">{remaining_html}
          </div>
        </section>

        <section>
          <h2>Holding back &mdash; best matchups in the next {report.lookahead_weeks} weeks</h2>
          {held_back_html}
        </section>

        <section>
          <h2>Pick history</h2>
          {history_html}
        </section>"""

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_esc(title)}</title>
<style>
  :root {{
    color-scheme: light dark;
    --bg: #f7f7f8; --card-bg: #ffffff; --text: #1a1a1a; --muted: #6b6b6b;
    --accent: #2563eb; --positive: #16a34a; --negative: #dc2626; --border: #e5e5e5;
  }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{ --bg: #16171a; --card-bg: #1f2023; --text: #f0f0f0; --muted: #9a9a9a;
      --accent: #60a5fa; --positive: #4ade80; --negative: #f87171; --border: #333438; }}
  }}
  :root[data-theme="dark"] {{
    --bg: #16171a; --card-bg: #1f2023; --text: #f0f0f0; --muted: #9a9a9a;
    --accent: #60a5fa; --positive: #4ade80; --negative: #f87171; --border: #333438;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }}
  .wrap {{ max-width: 780px; margin: 0 auto; }}
  header {{ margin-bottom: 24px; }}
  header h1 {{ font-size: 1.5rem; margin: 0 0 4px; }}
  header .generated {{ color: var(--muted); font-size: 0.85rem; }}
  section {{
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px;
    padding: 20px; margin-bottom: 20px;
  }}
  h2 {{ font-size: 1.1rem; margin: 0 0 16px; }}
  h3 {{ font-size: 0.95rem; margin: 0 0 8px; }}
  .picks {{ display: flex; gap: 16px; flex-wrap: wrap; }}
  .pick-card {{
    flex: 1 1 220px; border: 1px solid var(--border); border-radius: 10px; padding: 16px;
  }}
  .pick-card .team {{ font-size: 1.8rem; font-weight: 700; color: var(--accent); }}
  .pick-card .opponent {{ color: var(--muted); margin-bottom: 6px; }}
  .pick-card .winpct {{ font-weight: 600; }}
  .pick-card .estimated {{ font-weight: 400; color: var(--muted); font-size: 0.85rem; }}
  .pick-card .spread {{ color: var(--muted); font-size: 0.85rem; margin-top: 4px; }}
  .outcomes {{ display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }}
  .outcome {{
    flex: 1 1 140px; text-align: center; padding: 12px; border-radius: 8px;
    background: var(--bg);
  }}
  .outcome .value {{ display: block; font-size: 1.3rem; font-weight: 700; font-variant-numeric: tabular-nums; }}
  .outcome .label {{ display: block; color: var(--muted); font-size: 0.8rem; margin-top: 2px; }}
  .reasoning {{ color: var(--muted); font-size: 0.9rem; margin: 16px 0 0; line-height: 1.5; }}
  .pools {{ display: flex; gap: 16px; flex-wrap: wrap; }}
  .pool {{ flex: 1 1 300px; }}
  .pool .count {{ color: var(--muted); font-weight: 400; }}
  .pool .teams {{ color: var(--muted); font-size: 0.9rem; line-height: 1.6; margin: 0; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.9rem; font-variant-numeric: tabular-nums; }}
  th, td {{ text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }}
  th {{ color: var(--muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }}
  .team-cell {{ font-weight: 700; }}
  .positive {{ color: var(--positive); font-weight: 600; }}
  .result-win {{ color: var(--positive); font-weight: 700; }}
  .result-loss {{ color: var(--negative); font-weight: 700; }}
  .result-tie {{ color: var(--muted); font-weight: 700; }}
  .records {{ color: var(--muted); font-size: 0.9rem; margin: 0 0 12px; }}
  .none {{ color: var(--muted); }}
  footer {{ color: var(--muted); font-size: 0.8rem; text-align: center; margin-top: 32px; }}
  footer a {{ color: inherit; }}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>{_esc(title)}</h1>
      <div class="generated">Generated {_esc(generated_at)}</div>
    </header>
    {body}
    <footer>Output only &mdash; nothing here is submitted to your pool automatically. Recommendations only, not guarantees.</footer>
  </div>
</body>
</html>
"""
