# survivor-picker · Deadpool

Weekly pick recommendations for an NFL survivor pool, for two entries
(`Entry A`, `Entry B`) in the same private pool. It only ever *recommends* —
it never submits a pick anywhere. You still make the pick in your pool.

Two front ends over one engine:

- **[Deadpool](deadpool/)** — an installable web app on Cloudflare Pages,
  eventually at `deadpool.averageideas.dev`. Works offline, keeps everything in
  your browser, and is built to be opened on a phone twenty minutes before
  kickoff.
- **`main.py`** — the terminal pipeline: fetch, score, optimise, report, and
  confirm-and-record.

The picking logic is written once, in Python, and ported to JavaScript for the
browser. `test/parity.test.js` proves the two agree across ten scenarios —
every pick, every ordering, and every sentence of reasoning.

## The app

```bash
npm ci
npm run dev:fixtures     # deterministic, from frozen weeks
npm run dev              # against live ESPN
```

**One screen answers the question.** Both entries, both recommendations, above
the fold, with no navigation and no spinner over a cached board. Status is the
headline — "Both alive · Week 3 of 18" — and an eliminated entry stops being
given advice.

**Deadlines are per game.** A pick's window closes at its own kickoff, not at
some pool-wide time, so a team whose game has started is greyed out with the
reason attached instead of silently vanishing.

**An estimate never looks like a measurement.** ESPN's published model and a
spread-derived guess are different things to know; the figure, its label and
the bar all turn amber together when it is the second.

**Nothing leaves the device.** Every pick is in `localStorage`. The
Content-Security-Policy pins `connect-src` to `'self'`, so the only host the
page can reach is its own origin — enforced by the browser rather than by good
intentions. The one thing on that origin is a stateless proxy that reads ESPN
and holds nothing.

### Why there is a server-side piece at all

ESPN's endpoints send no `Access-Control-Allow-Origin`, so a browser cannot
call them. Not slowly, not with a workaround — at all. `deadpool/functions/api/`
is a Cloudflare Pages Function that does the fetching, and once it exists it
pays for itself four times over: the week's 1 + 2N requests become one, they
happen in parallel at the edge instead of serially on a phone, the cache is
shared by every device instead of per-device, and the ESPN parser stays in one
place rather than shipping to the browser.

It caches with a TTL tiered by how close the first kickoff is — six hours early
in the week, fifteen minutes inside three hours of kickoff, sixty seconds once
anything is live. A flat four hours is fine on a Tuesday and exactly wrong at
12:45 on a Sunday.

### Adding a strategy

One file and one `register()` line. It arrives in the app with its parameters
as working controls, its picks in the comparison table, and its output on the
Week screen, with no interface written for it — because parameters are declared
as data.

```js
// deadpool/src/engine/strategies/contrarian.js
export default {
  id: 'contrarian',
  name: 'Against the field',
  blurb: 'Discounts a team by how much of the pool is likely to be on it.',
  entries: 'both',
  params: [
    { key: 'fieldWeight', label: 'How much the field matters',
      type: 'float', default: 0.3, min: 0, max: 1, step: 0.05 },
  ],
  run(ctx) {
    // Pure. No fetch, no Date.now(), no Math.random().
    return { picks, candidates, considered, warnings };
  },
};
```

The suite enforces the rest: purity (checked statically, by reading the files),
determinism, that no strategy offers a used team or puts both entries in one
game, and that a broken plug-in is contained rather than blanking the screen.

**Pick popularity is the largest strategic gap and is deliberately not built.**
If most of the pool takes the same favourite and it loses, everyone dies
together and your edge was worth nothing. It is a new strategy, which is what
the registry exists to make cheap.

## How the engine works

`data/espn_client.py` pulls three things from ESPN's unofficial (undocumented)
API:

1. Schedule and live scores — `site.api.espn.com/.../scoreboard`
2. Win probabilities — `sports.core.api.espn.com/.../probabilities`
3. Odds/spread — `sports.core.api.espn.com/.../odds`

Because these endpoints are unofficial, the client is conservative about
request volume and defensive about parsing: every response is cached under
`cache/` for `CACHE_TTL_HOURS` (default 4h) and falls back to a stale copy
rather than failing the run; outbound requests retry with exponential backoff;
and all field access goes through a safe getter, so a renamed field degrades to
`None` instead of crashing.

`models/win_prob.py` builds a per-team, per-week win probability table,
preferring ESPN's own figure and falling back to a spread-derived estimate,
tagging each with its `source` so callers know how much to trust it.

`models/future_value.py` scores whether a team is worth holding back: it looks
ahead a few weeks, discounts each by distance, and compares the best future
matchup to using them now. A positive `future_value` means a better spot is
probably coming.

`picker/recommender.py` ranks each not-yet-used team by win probability and
flags when both entries' top pick is the same team.

`strategy/entry_a_value.py` scores each team as
`win_pct * (1 - future_value_penalty)`, so a team with a better matchup coming
is discounted rather than spent now.

`strategy/entry_b_hedge.py` treats Entry A's pick as fixed and takes Entry B's
safest team from a *different* game, above a win-probability floor (default
65%). If nothing clears the floor it is relaxed rather than leaving Entry B
without a pick, and that is said out loud.

`strategy/joint_optimizer.py` searches every valid `(team_a, team_b)` pair at
once and maximises `P(A wins) + P(B wins) − P(both lose)`. The pair is always
required to come from different games, so the independence assumption holds by
construction rather than by hope.

`state/entries_store.py` records each entry's picks as
`{"week": int, "team": str}`, and `pick_history.py` resolves each against
ESPN's actual result for that week.

`report.py` holds the read-only pipeline — fetch, table, optimise, report —
that `main.py weekly` and `generate_report.py` both build on, so the terminal
and the HTML report cannot drift.

## Usage

```bash
pip install -r requirements.txt

python main.py weekly                    # fetch, score, optimise, report, confirm-and-record
python main.py weekly --week 3 --lookahead-weeks 4 --min-win-prob-floor-b 70
python main.py weekly --yes              # skip the confirmation (still prints first)

python main.py recommend                 # ranked candidates, no optimisation, no state changes
python main.py record-pick --entry "Entry A" --team KC --week 5
python main.py show-history              # used teams plus the win/loss table

python generate_report.py --out report.html   # the static HTML report, by hand
```

> `generate_report.py` used to be published to GitHub Pages by a scheduled
> workflow. That workflow is gone — the app replaces it — so this is a local
> artifact now. Nothing else reads it.

## Layout

```
deadpool/          the app          → Cloudflare Pages project root
  functions/api/     the edge proxy
  src/engine/        the ported engine + strategy registry
  src/store/         localStorage; the pick log is the only truth
  src/views/         four screens
main.py            the terminal pipeline
report.py          the read-only pipeline both front ends share
data/ models/ picker/ strategy/ state/    the engine
fixtures/          frozen weeks + the Python's recorded output
test/              node --test: parity, store, engine contract, formatting
tests/             pytest: the Python
scripts/           authoring and check tools
```

## Before you push

```bash
npm run check       # palette, shipped code, service-worker stamp, golden output, JS suite
python3 -m pytest -q
```

- **Palette** — every text token against its worst *real* ground (the tinted
  washes count as surfaces), the surface ladder in **L\***, not as a contrast
  ratio, and the measured comment beside each value.
- **Shipped code** — no inline `style` attributes (`style-src 'self'` refuses
  them silently), every `data-act` wired to a handler, every identifier a view
  calls actually declared, nothing reaching another origin.
- **Stamp** — the service worker's precache list is derived from disk, so a
  file cannot ship uncached and break offline only for people who installed it.
- **Golden** — the Python has not changed under the port.

Tests must never touch the network. A test that reaches ESPN passes on a laptop
with no internet and then fails on CI, which is the wrong way round.

## Two things worth knowing

**The fixtures are generated, not captured.** This was built somewhere that
cannot reach `site.api.espn.com`. They are written to the shape the parser
reads, which makes them fully sufficient for proving the two engines agree from
identical input — and blind to exactly one thing: ESPN renaming a field. Run
`node scripts/capture-week.mjs --week N` from a machine with network access to
replace them with real captures.

**A tie is scored as a loss by default, and nothing reasons about it yet.**
ESPN publishes a tie probability that none of the strategies read, so every
survival figure they quote is optimistic by roughly that much. The app records
the rule; the engine does not yet weigh it.
