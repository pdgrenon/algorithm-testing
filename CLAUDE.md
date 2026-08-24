# Working in this repo

Conventions and traps, each one here because it actually cost time rather than
because it seemed like good advice. Read the module docblocks for *why* the
code is shaped as it is; this file is about operating on it without repeating
a known mistake.

## Long measurement runs

`scripts/backtest.py --synthetic N` is the harness everything is measured
with. Runs are hours, so getting the invocation wrong is expensive.

**Keep stderr.** `_progress` writes the season counter to **stderr**, on
purpose — its docstring says "so it never lands in a redirected report", which
is right, and it means `2>/dev/null` throws away the only progress signal
there is. Four separate runner scripts in this repo's history did exactly
that, and the last one overran its estimate by 15 minutes with no way to tell
how far along it was. The counter is not buffered and not recoverable after
the fact; `/proc/<pid>/fd/2` will just say `/dev/null`.

```bash
# wrong: silences the progress counter for the whole run
python3 scripts/backtest.py ... 2>/dev/null >> "$OUT"

# right: report to the file, counter still on the terminal
python3 scripts/backtest.py ... >> "$OUT"
# or keep both, counter interleaved into its own file
python3 scripts/backtest.py ... >> "$OUT" 2>> "$OUT.progress"
```

Note the asymmetry: *stdout* to a file really is block-buffered, so the report
appears only at exit. A log that sits at a few hundred bytes for an hour is
normal. Elapsed CPU (`ps -o etime,time,pcpu`) is the reliable liveness check.

**Never `pkill -f` a pattern that matches your own command line.** This killed
the shell mid-task twice here — once on `pkill -f "backtest.py"`, once on
`pkill -f "scripts/dev.mjs"` — because the pattern appears in the very command
running it, so `pkill` matches itself. Break the literal with a character
class:

```bash
pkill -f "backtes[t]\.py"      # matches the target, not this command
pkill -f "de[v]\.mjs"
```

**Timings, measured, so estimates are calibrated rather than guessed.** All at
`--synthetic 10000 --fields 25 --jobs 4`:

| strategies | wall time |
|---|---|
| 8 (incl. `leverage`, `lev-g0`) | ~85 min |
| 3 (incl. `leverage`) | >58 min |

`leverage` is much more expensive per season than the others — it rebuilds a
field forecast from every opponent's inventory every week, where `distinct`
and `joint` only read the board. Do not scale a time estimate by strategy
count without accounting for which ones.

## The suite cannot see the page

`node --test` has no DOM. `src/app.js` and everything in `src/views/` are the
largest unexecuted files in the repo, and **a passing suite says nothing about
whether the app renders.** Three shipped faults found this out:

* `.bar__fill` was an `<i>`, so `width: 75%` did nothing and every bar drew
  0×0. 268 tests passed.
* `renderStrategy` read `state.poolSize` and was never passed `state` — a bare
  identifier, and `check-shipped` resolves *calls*, so every static check
  passed and it threw on render.
* `observedChalkiness()` was written, exported, tested, and imported by
  nothing, while a settings help string told users the Pool screen displayed
  it.

So: **anything that changes rendered output gets photographed before it is
called done.** `node scripts/shots.mjs` against `npm run dev:fixtures` writes
to `shots/`. Check a real bounding box, not just presence — `0×0` is the
failure mode a snapshot of the HTML would miss.

For a Pool screen with actual data, point the dev server at a local sheet;
`/api/pool` takes any `http(s)` URL:

```bash
POOL_SHEET_URL="http://localhost:8099/pool.csv" npm run dev:fixtures
```

## Measurement discipline

**One table, one run.** `engine/measured.js` says "FILLED FROM THE RUN ABOVE"
and means it. Every number moved between n=2500 and n=10000 — `distinct` 1.72
to 1.91, `ranked` 0.74 to 0.88 — so a table with rows from different sample
sizes cannot be read across itself. Re-running one strategy is never enough.

**Synthetic seasons are seeded by index** (`synth.season(i)`), so a larger run
*contains* a smaller one. Checkpoint curves are therefore genuine
"add more data" curves and can distinguish √n growth from a number wandering.
This is the only reason the `leverage` falsification is trustworthy.

**Two metrics, and they answer different questions.** Pot share is what the
pool pays and is zero in ~96% of seasons, so most *pairs* tie in most seasons
— `distinct` vs `joint` rests on 674 informative seasons out of 10,000. Weeks
survived ties far less (1,472–6,923 informative). Both are printed. Where they
disagree, that *is* the finding: separating on depth but not money means
surviving longer without converting it.

**Depth is field-independent for field-blind strategies.** `distinct`, `joint`
and `sequential` never read the field, so their weeks-survived numbers cannot
depend on the field model at all — verified by holding seasons fixed and
changing `--fields` and `--field-tau`, where the paired depth row came out
bit-identical while money swung from 0.64× to 1.98× fair and flipped sign.
Money conclusions are conditional on the field; depth conclusions are not.
This makes an excellent free control on any run that varies the field.

**Two assumptions were hardcoded for a long time.** The field's concentration
(`--field-tau`, default `CASUAL_TAU = 0.35`) and the 250-entry pool size. The
first is now a flag and is printed in the run header; the second is still
fixed in the two-entry path. Any x-fair number is conditional on both.

**`--robustness` is not the same knob.** It varies what a strategy is *told*
while the field keeps behaving at `CASUAL_TAU`. That moves only strategies
that *read* the field, so it says nothing about `distinct`/`joint`/
`sequential`, whose belief rows would be identical.

**`t > 2` is a hypothesis, not a result**, until it holds at several times the
sample. Three strategies have led a table and then collapsed: `potshare`
(t=2.99 at n=400 → 1.01 at 2000), `ps-h4` (best of eight at 800, behind at
2500), `leverage` (1.60 at 2500 → 0.75 at 5000 → sign flipped at 10000). A top
mean here is where a strategy goes to be falsified.

## Python is the oracle, JavaScript is the port

The picking logic is written in Python and ported to JS. `test/parity.test.js`
plus `fixtures/golden/` hold them together — every pick, every ordering, every
sentence of reasoning. Change one side, change the other, and re-run
`npm run golden:check`.

The engine must not import from `scripts/`, which is where anything that
fetches lives — that rule is what keeps network access out of the suite. When
`leverage` needed the field-forecast maths that lived in `scripts/field.py`,
the functions **moved** to `models/field_forecast.py` rather than being
copied; two copies of a scoring function used by both the field generator and
a strategy reading it would drift into a measured edge that was an artefact of
the disagreement. This is a convention enforced by review, not by a test.

Strategies must stay pure: no fetch, no `Date.now()`, no `Math.random()`. That
one *is* enforced — `test/engine.test.js` scans the shipped strategy sources
for those patterns, so a stray `Date.now()` fails the suite rather than
producing a recommendation that quietly changes between runs.

## Before pushing

```bash
npm run check      # palette, shipped-code checks, golden fixtures, SW stamp, tests
python3 -m pytest -q
node scripts/stamp-sw.mjs   # if any shipped file changed; `check` fails otherwise
```

`npm run check` runs `stamp-sw --check`, which fails whenever a precached file
changed without the service worker being re-stamped. That is the usual reason
a green local run goes red — re-stamp, don't chase it.
