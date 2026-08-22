# Deadpool

**Two entries, one NFL survivor pool, and the pick that keeps them both alive.**

An installable web app on Cloudflare Pages, wrapped around the
[`survivor-picker`](survivor-picker/) engine. Everything you enter stays in your
browser on your device. It works with no signal, it has no account, and — like
the terminal tool it wraps — it never submits a pick anywhere. You still make
the pick in your pool.

```
deadpool/        the app        → Cloudflare Pages project root
survivor-picker/ the engine     → Python, the reference implementation
fixtures/        frozen weeks   → what both engines are tested against
test/            node --test    → parity, store, engine contract, formatting
scripts/         authoring and check tools
```

## What it is

The Python is good, and three of its five algorithm modules had never run. This
wraps it rather than replacing it: the picking logic is ported line for line
into `deadpool/src/engine/`, and `test/parity.test.js` proves the port agrees
with the Python across ten scenarios — every pick, every ordering, and every
sentence of reasoning.

Everything else is the infrastructure that was missing.

## What the audit found

Worth reading before changing anything, because two of these are why the app
is shaped the way it is.

**Three of the five strategy modules were unreachable.** `main.py` imports
`picker.recommender` and nothing else. `entry_a_value`, `entry_b_hedge` and
`joint_optimizer` — the good ones — are referenced only in each other's
docstrings. The CLI's `recommend` runs the simple win-probability ranking.

**The lookahead was inert on every path that would use it.**
`build_win_probability_table` is called from the test suite and from nowhere
else. Even wired up, `entry_a_value` would be fed a table built from
`get_week_games`, which fetches *one* week — so `remaining_schedule` came out
empty, `future_value` came out `None`, the penalty was flat zero, and the
strategy silently behaved like plain ranking. The tests passed because they
hand it a multi-week table by hand.

Nothing in the algorithm changed to fix that. It needed a season, and
`/api/season` is where one comes from. `fixtures/golden/w01-fresh.json` and
`w01-no-schedule.json` are the same week with and without one, and the rankings
differ — which is the whole of the difference.

**A pick had no outcome and no week.** `used_teams_a.json` is a flat list of
abbreviations, so the tool could not answer the only question a survivor pool
asks. `deadpool/src/store/` stores the picks and derives everything else.

Three more, smaller: a week costs 33 HTTP requests (fatal on a phone, fixed at
the edge); a started game vanishes from the board without a word (the app says
so); and `tie_pct` is parsed and never read, so every survival figure the
strategies quote is optimistic by roughly that much (recorded as a pool rule,
not yet reasoned about).

## The shape

**Edge** — `deadpool/functions/api/`. ESPN sends no CORS header, so a browser
cannot call it at all; this is not optional. The Function fans out in parallel,
normalises, and caches with a TTL tiered by how close the first kickoff is —
six hours early in the week, fifteen minutes inside three hours of kickoff,
sixty seconds once anything is live. One origin behind a shared cache asks ESPN
for a week far less often than every device would.

**Engine** — `deadpool/src/engine/`. Pure: no network, no clock, no randomness.
Same context in, same recommendation out, forever. That is what makes a season
replayable, the golden fixtures possible, and `test/engine.test.js` checks it
by reading the files rather than by running them.

**Store** — `deadpool/src/store/`. The pick log is the only thing written down.
Used teams, alive-or-out, strikes, the record and the board are all derived, so
correcting one pick corrects the whole app. Two keyspaces: your record, which
is never evicted, and cached weeks, which are.

**Shell** — `deadpool/src/views/`. Four screens. Week opens on the answer.

## Adding a strategy

One file and one line. It arrives in the app with its parameters as working
controls, its picks in the comparison table, and its output on the Week screen,
with no interface written for it.

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
    // ctx: { season, week, games, schedule, entries, usedTeams, params, … }
    // Pure. No fetch, no Date.now(), no Math.random().
    return { picks, candidates, considered, warnings };
  },
};
```

Then `register(contrarian)` in `deadpool/src/engine/index.js`. The suite
enforces the rest: purity, determinism, that no strategy offers a used team or
puts both entries in one game, and that every declared parameter can be drawn.

Pick popularity is the single largest strategic gap here and is deliberately
not built — it is a new strategy, and the registry is what makes it a single
file when you want it.

## Development

```bash
npm ci                       # Playwright, for the one check that needs a browser
npm run dev:fixtures         # the app on frozen weeks, deterministic
npm run dev                  # the app against live ESPN
```

`--fixtures` is not only for a machine with no network. It makes the whole app
deterministic and exercises the awkward weeks a live Tuesday never shows you: a
relaxed floor, games already under way, a board with no line published, and a
week engineered to sit on a rounding boundary.

```bash
npm run shots                # photograph every view, both themes, fail on a console error
npm run golden               # regenerate the Python oracle's output
npm run palette              # contrast, the L* ladder, the measured comments
```

## Before you push

```bash
npm run check
```

Runs the palette check, the shipped-code check, the service-worker stamp, the
golden-output check and the suite. What each is for:

- **Palette** — every text token against its worst *real* ground (the washes
  count), the surface ladder in L\* rather than as a contrast ratio, and the
  measured comment beside each value.
- **Shipped code** — no inline `style` attributes (`style-src 'self'` refuses
  them silently), every `data-act` wired to a handler, every identifier a view
  calls actually declared, and nothing reaching another origin.
- **Stamp** — the service worker's precache list is derived from disk, so a
  file cannot ship uncached and break offline for people who installed it.
- **Golden** — the Python has not changed under the port.

Tests must never touch the network. A test that reaches ESPN passes on a laptop
with no internet and then fails on CI, which is the wrong way round.

## Nothing here has been checked against a real ESPN response

The fixtures are generated, not captured — this repository was built somewhere
that cannot reach `site.api.espn.com`. They are written to the shape the parser
reads, which makes them fully sufficient for what they exist for (proving the
two engines agree from identical input) and blind to exactly one thing: ESPN
renaming a field. Run `scripts/capture-week.mjs` from a machine with network
access to replace them with real captures.
