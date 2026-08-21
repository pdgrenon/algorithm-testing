# survivor-picker

Weekly pick recommendations for an NFL survivor pool, for two entries
(`Entry A`, `Entry B`) in the same private pool. This tool only prints
recommendations -- it never submits a pick anywhere. You still make the
actual pick in your pool's site/app.

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

`state/entries.json` tracks which teams each entry has already used. This
is local file state you update yourself via `record-pick` after you make
your real pick elsewhere -- survivor-picker never touches your pool.

## Setup

```bash
pip install -r requirements.txt
```

## Usage

```bash
# Print ranked recommendations for the current week
python main.py recommend

# A specific week
python main.py recommend --week 3

# After you've actually made a pick in your pool, record it so future
# weeks exclude that team for that entry
python main.py record-pick --entry "Entry A" --team KC

# See what's already been used
python main.py show-history
```

## Project layout

```
survivor-picker/
  config.py              entries, cache dir/TTL, season type
  data/
    espn_client.py        ESPN API client: fetch + cache + retry + parsing
    models.py              Game/Team/WinProbability/Odds dataclasses
  picker/
    recommender.py         ranks candidates per entry
  state/
    entries_store.py       load/save used-teams-per-entry
    entries.json            the actual state file
  cache/                   per-week JSON response cache (gitignored)
  main.py                  CLI (recommend / record-pick / show-history)
  tests/
    test_espn_client.py    cache + parsing tests (mocked HTTP)
```

## Notes on being a good API citizen

ESPN does not publish or support these endpoints. This project keeps
request volume low on purpose: aggressive caching (hours, not minutes),
retry/backoff instead of hammering on failure, and a minimum delay
between outbound requests. If you lower `CACHE_TTL_HOURS`, keep it
reasonable -- there's no need to re-fetch more than a few times a day
outside of live game windows.
