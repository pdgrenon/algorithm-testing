# survivor-picker

Weekly pick recommendations for an NFL survivor pool, for two entries
(`Entry A`, `Entry B`) in the same private pool. This tool only prints
recommendations -- it never submits a pick anywhere. You still make the
actual pick in your pool's site/app.

## View this week's report (no coding required)

This repo automatically publishes the weekly report as a webpage via
GitHub Pages, refreshed every Tuesday and Friday, or on demand.

**One-time setup** (a repo admin only has to do this once):

1. On GitHub, go to this repo's **Settings** tab.
2. In the left sidebar, click **Pages**.
3. Under "Build and deployment" → "Source", choose **GitHub Actions**.

After that, the page updates itself automatically -- nothing more to do.
The report's URL will be shown at the top of Settings → Pages once the
first run completes (it looks like
`https://<your-github-username>.github.io/algorithm-testing/`).

**To refresh it right now** instead of waiting for the schedule: go to
this repo's **Actions** tab, click **Weekly Survivor Report** in the left
list, then click the **Run workflow** button.

Because this repo is public, the published page (and the picks recorded
in `state/`) are visible to anyone with the link -- there's nothing
sensitive in it (just team abbreviations and win probabilities), but
worth knowing.

## How it works

`data/espn_client.py` pulls three things from ESPN's unofficial (undocumented)
API for the current week:

1. Schedule and live scores -- `site.api.espn.com/.../scoreboard`
2. Win probabilities -- `sports.core.api.espn.com/.../probabilities`
3. Odds/spread -- `sports.core.api.espn.com/.../odds`

Because these endpoints are unofficial, the client is conservative about
request volume and defensive about parsing:

- **Caching**: every response is cached to a JSON file under `cache/`,
  refreshed at most every `CACHE_TTL_HOURS` (default 4h, see `config.py`).
  If a live fetch fails, the client falls back to whatever is cached on
  disk, even if stale, instead of failing the whole run.
- **Retries**: outbound requests use `urllib3.Retry` with exponential
  backoff on connection errors and 429/5xx responses, plus a small
  self-imposed minimum delay between requests.
- **Graceful field fallback**: all JSON field access goes through a safe
  getter, so a missing or renamed field from ESPN degrades to `None`
  instead of crashing. If win probability isn't available yet, the
  recommender falls back to a rough estimate from the betting spread.

`picker/recommender.py` ranks each team not yet used by an entry by win
probability (highest first) and flags if both entries' top pick is the
same team, so you can diversify.

`models/win_prob.py` builds a clean, per-team, per-week win probability
table for the season: it prefers ESPN's own probability field (normalized
to a 0-100 scale) and falls back to a spread-derived estimate when ESPN
hasn't published one yet, tagging each entry with its `source` so callers
know how much to trust it.

`models/future_value.py` scores whether a team is worth holding back:
given a team's remaining schedule, it looks ahead (default 6 weeks,
weighted heaviest in the next 4-6) and compares the best discounted future
matchup to using that team this week. A positive `future_value` means a
better spot is likely coming -- this is what a future optimizer would use
to avoid burning a strong team too early.

`state/used_teams_a.json` and `state/used_teams_b.json` track which teams
each entry has already used across the season, one file per entry so their
histories stay independent. This is local file state you update yourself
via `record-pick` after you make your real pick elsewhere -- survivor-picker
never touches your pool.

`strategy/entry_a_value.py` is Entry A's weekly pick strategy: it scores
each not-yet-used team as `win_pct * (1 - future_value_penalty)`, where the
penalty (capped, see `MAX_FUTURE_VALUE_PENALTY`) comes from `future_value.py`
-- so a team with an even better matchup coming up in the next few weeks
gets discounted rather than automatically recommended now. It returns the
top pick plus plain-English reasoning (win prob, spread, and why it beat
the next-best alternative).

`strategy/entry_b_hedge.py` is the lightweight, sequential way to pick for
Entry B: treat Entry A's pick as already fixed, then take Entry B's
highest win-probability team from a *different* game (so a single result
can't eliminate both entries), as long as it clears a minimum win-probability
floor (default 65%). If nothing clears the floor, the floor is relaxed
rather than leaving Entry B without a pick, and that's called out in the
reasoning.

`strategy/joint_optimizer.py` is the real joint optimization: instead of
fixing Entry A's pick first, it brute-force searches every valid
`(team_a, team_b)` pair -- never a used team, never the same team twice,
never two teams from the same game -- and picks the one that maximizes
`P(A wins) + P(B wins) - P(A loses AND B loses)` (independence assumed
between the two picks' games, which always holds here since they're
required to be different games). Entry B's win probability still has to
clear the same configurable floor. Output includes both picks, the
reasoning, and the estimated "both survive" / "one survives" / "both
eliminated" probabilities for the week.

`main.py`'s `weekly` command ties all of the above into one pipeline: fetch
this week's games plus the next few weeks (for the look-ahead report),
build the win-probability table, run the joint optimizer, print a report,
and -- only if you confirm -- record the picks into the state files. Steps:

1. Fetch the current week (+ `--lookahead-weeks`, default 3, more weeks)
   from ESPN via `data/espn_client.py` (cached, retried, rate-limited).
2. Build the season win-probability table (`models/win_prob.py`).
3. Run `strategy/joint_optimizer.py` for this week's recommended pair.
4. Find teams playing this week that are available to at least one entry,
   aren't this week's picks, and have a genuinely better matchup projected
   within the look-ahead window (`models/future_value.py`'s `should_hold`).
5. Print the report: both picks with win probabilities and spreads, the
   both-survive/one-survives/both-eliminated breakdown, each entry's
   remaining team pool (all 32 teams minus used ones), and the held-back
   teams' best upcoming matchup.
6. Prompt to confirm before writing anything -- only on "y" does it call
   `state/entries_store.py`'s `record_pick` for both entries. Nothing is
   ever recorded, and nothing is ever submitted to your pool, without that
   confirmation (or `--yes` if you want to skip the prompt).

`report.py` holds steps 1-5 above as reusable, read-only functions (never
writes state) -- both `main.py weekly` (terminal report + optional
confirm-and-record) and `generate_report.py` (a static HTML page, styled
for light/dark and mobile) build on it, so the two never drift apart.
`.github/workflows/weekly-report.yml` runs `generate_report.py` on a
schedule and publishes the result to GitHub Pages -- see "View this
week's report" above.

## Setup

```bash
pip install -r requirements.txt
```

## Usage

```bash
# Full weekly pipeline: fetch, score, optimize, report, confirm-and-record
python main.py weekly

# A specific week, a longer look-ahead, a stricter Entry B floor
python main.py weekly --week 3 --lookahead-weeks 4 --min-win-prob-floor-b 70

# Skip the confirmation prompt (still prints the report first)
python main.py weekly --yes

# Print ranked recommendations for the current week (no optimization, no state changes)
python main.py recommend

# A specific week
python main.py recommend --week 3

# After you've actually made a pick in your pool, record it so future
# weeks exclude that team for that entry
python main.py record-pick --entry "Entry A" --team KC

# See what's already been used
python main.py show-history

# Generate the static HTML report by hand (this is what the GitHub Actions
# workflow runs automatically -- you shouldn't normally need to run it
# yourself, but it's here if you want to preview docs/index.html locally)
python generate_report.py --out docs/index.html
```

## Project layout

```
.github/workflows/
  weekly-report.yml         scheduled + on-demand GitHub Pages publish
config.py                  entries, cache dir/TTL, season type
data/
  espn_client.py            ESPN API client: fetch + cache + retry + parsing
  models.py                 Game/Team/WinProbability/Odds dataclasses
  teams.py                  static list of all 32 NFL team abbreviations
picker/
  recommender.py            ranks candidates per entry
models/
  win_prob.py               per-team, per-week win probability (API + spread fallback)
  future_value.py           decaying-lookahead "hold back or use now" scoring
strategy/
  entry_a_value.py          Entry A's weekly pick: win_pct * (1 - future_value_penalty) + reasoning
  entry_b_hedge.py          Entry B's sequential hedge against Entry A's game + win-prob floor
  joint_optimizer.py        joint (A, B) pair search maximizing combined survival objective
state/
  entries_store.py          load/save used-teams-per-entry
  used_teams_a.json         Entry A's used-teams state file
  used_teams_b.json         Entry B's used-teams state file
cache/                      per-week JSON response cache (gitignored)
docs/                        generated HTML report output (gitignored; published by the workflow)
report.py                   shared read-only pipeline: fetch + score + optimize + render (text/HTML)
generate_report.py          writes report.py's HTML render to docs/index.html
main.py                     CLI (weekly / recommend / record-pick / show-history)
tests/
  test_espn_client.py       cache + parsing tests (mocked HTTP)
  test_win_prob.py          win-probability blending tests
  test_future_value.py      future-value decay tests
  test_entries_store.py     per-entry state file tests
  test_entry_a_value.py     Entry A strategy scoring + reasoning tests
  test_entry_b_hedge.py     Entry B hedge scoring + reasoning tests
  test_joint_optimizer.py   joint-search constraints + objective tests
  test_report.py            pipeline: fetch orchestration + held-back logic
  test_main.py              CLI confirmation prompt + no-data path
  test_generate_report.py   HTML report generation script
```

## Notes on being a good API citizen

ESPN does not publish or support these endpoints. This project keeps
request volume low on purpose: aggressive caching (hours, not minutes),
retry/backoff instead of hammering on failure, and a minimum delay
between outbound requests. If you lower `CACHE_TTL_HOURS`, keep it
reasonable -- there's no need to re-fetch more than a few times a day
outside of live game windows.
