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
headline — "Both alive · Week 3 · 2026" — and an eliminated entry stops being
given advice.

**Deadlines are per game.** A pick's window closes at its own kickoff, not at
some pool-wide time, so a team whose game has started is greyed out with the
reason attached instead of silently vanishing.

**The alarm is a calendar file, because a browser cannot set one.** The most
common way to lose a survivor pool is not picking the wrong team — it is not
picking. A browser cannot schedule a notification for a future time; the only
route to "tell me at 12:45 on Sunday" is a push server, which is a server
holding your picks. So Settings exports the season as `.ics` instead: every
pick you have made, and, for any week you have not, an alarm the day before and
again ninety minutes out with the current recommendation in the body. The
calendar app fires it, on the device, offline.

**And a feed you subscribe to once, which is a redirect and nothing else.**
`/api/calendar` serves every remaining week's lock time — no token, no upload,
no picks, no prices, no idea who is asking. One URL for everyone, regenerated
per fetch, and it says one thing: *week 7 closes at the first kickoff, open
Deadpool*.

That is the whole specification rather than a compromise. A reminder fires at
the right moment and is read in two seconds — exactly enough to send you
somewhere, nowhere near enough to carry something you might act on. Three
richer versions were considered and all three fail, which is written down in
`engine/calendar.js` so nobody re-derives them: your pick needs an inventory
that changes weekly behind a URL that is fixed forever; a recommendation decays
in hours against a client refresh of up to a day; and even the board's biggest
favourites — which need nothing personal — had to be followed by a sentence
admitting the feed cannot know which of them you have spent. Content that must
be qualified into uselessness should not be there.

Everything the app knows is one tap away and correct. A reminder competing with
it can only be a staler copy.

**Finished games settle their own picks.** The app was already holding the
score that answers it — `/api/week` carries `winner` and `state` — and made you
tap it in anyway. Now it settles pending picks from the payload and from cached
weeks, so a pick made on Sunday is resolved by Monday without help. A tie is
told from a loss by comparing scores rather than by reading `winner`, which is
`false` on *both* sides of a tie. Anything you set by hand is stamped `manual`
and is never overwritten: a pool can rule a game in a way the feed does not.

**An estimate never looks like a measurement.** ESPN's published model, a
de-vigged market price and a spread-derived guess are three different things
to know, and the card names which one it is drawing — `espn`, `market` or
`est`. Only the last is a rule of thumb, so only the last turns the figure,
its label and the bar amber.

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

### `leverage`, the one that reads the field

If most of the pool takes the same favourite and it loses, everyone dies
together and your edge was worth nothing. `strategy/leverage.py` is the first
thing here that can see that coming: `/api/pool` gives the surviving entries'
exact inventories, `models/field_forecast.py` turns them into what the pool is
likely to do this week, and the strategy moves off the crowd where the board
makes it nearly free.

It is `distinct` — top of the table at the largest sample run — with one
addition, and it moves only when **two** conditions hold together:

1. the alternative is within `tolerance` points of `distinct`'s pick, which
   bounds what the move can cost, and
2. it is at least `min_gain` less crowded, which is what makes the move worth
   making.

With no sheet configured it is `distinct` *exactly* — the same pick, not a
similar one, and the parity suite asserts it on every run that carries no
field.

**The second condition was learned by measuring, and it changes what the
strategy is.** The first version moved to the least-crowded team anywhere in
the band, which sounds free and is not: forecast share falls monotonically with
win probability, so "least crowded within two points of the best" is always
*the worst team within two points of the best*. There is always such a team, so
the move fires every week — which makes it a rescoring wearing a tie-break's
clothes, spending the full tolerance every week for a percentage point of
differentiation. `lev-g0` in `scripts/backtest.py` is that version, kept
runnable.

**And then the whole strategy was falsified.** Over 2,500 seasons it was the
highest mean in the table — 1.87x fair, not separated from `distinct` at
t = 1.60 — so the curve was run to settle it. The synthetic seasons are seeded
by index, so the samples are *nested*: the first 2,500 of the 10,000 are the
same 2,500, which is the only version of this that can tell growth from
wandering. A real difference grows like the square root of the sample. This one
went 1.60 at n=2,500, 0.75 at 5,000, and at 10,000 the sign had flipped —
`distinct` leads by 0.30. That is the third strategy here to look like a winner
and collapse, after `potshare` and `ps-h4`.

**The depth table then said what actually went wrong**, which the money never
could. On weeks survived `distinct` beats it at t = 3.84, while the money stays
a dead heat at 0.30. Read that pairing as the sentence it is: `leverage`
survived measurably less long and still took the same share of the pot. That is
this strategy's trade *working* — it gives up survival to sit away from the
crowd, and the differentiation pays for the survival it costs, precisely, and
no more.

A break-even trade is not worth a fetch, an inventory and a model. It is also
why the harness prints two metrics now: on money alone this reads as "no
difference", when what is happening is two real effects cancelling.

**And then it was tested where its premise is strongest, which is the part
that finishes the argument.** Every run above put the field at
`CASUAL_TAU = 0.35` — the *least* concentrated point on the ladder (SHARP
0.15, AVERAGE 0.25, CASUAL 0.35). Condemning a crowd-avoidance strategy having
only ever raced it against the thinnest crowd is not a finished falsification.

So: 10,000 seasons at tau = 0.15, with two controls checked first. The
field-blind depth row came out bit-identical to the casual run (`distinct` over
`joint`, t = 3.36, 1406 vs 1233), and the opponents' best depth fell 15.60 →
13.76, which is a chalkier field spending its inventory faster and dying
earlier.

| | tau 0.35 | tau 0.15 | |
|---|---|---|---|
| `distinct` > `joint`, money | 2.43 | **5.67** | ordering holds, gap grows |
| `distinct` > `joint`, depth | 3.36 | 3.36 | the control |
| `leverage` vs `distinct`, money | 0.30 | **0.30** | unchanged to two decimals |
| `distinct` > `leverage`, depth | 3.84 | **4.41** | costs *more* survival here |

Everyone earns more against a field that kills itself — `distinct` 3.62× fair,
`leverage` 3.64×, `joint` 2.99×. But stepping aside from the crowd does not buy
a bigger share of that. Given the best case its own premise can ask for,
`leverage` is the same break-even trade to two decimal places and gives up more
survival to make it.

**The `min_gain` evidence took two metrics to get right, and the first attempt
at it was written too confidently.** This file used to say `lev-g0` came in at
1.67 and below `distinct`, confirming the pilot. It did — at t = 0.26, which is
not a separation and should never have been read as one. At n=10,000 `lev-g0`
is 1.83, and paired on money `distinct` leads it by 0.75 and `leverage` by
0.64. **No pot-share number justifies the parameter, and none ever did.**

On **weeks survived** it separates decisively: `leverage` over `lev-g0` is
t = 4.20 and `distinct` over `lev-g0` is 5.34, on roughly 5,600 informative
seasons. `lev-g0` reaches week 6.32 against `leverage`'s 6.47 — a gap that
looked like rounding beside an unmeasurable money column, and is one of the
sharper results in the table once paired on the metric that can see it.

So the threshold is justified by measurement after all: not by the money, which
cannot resolve it, but by the survival it stops the strategy from spending —
which is exactly what the design argument said it was for.

One number from the first write-up does not reproduce and is withdrawn: the
pilot's "Week 3.9 against `distinct`'s 5.7". At the settings the table is run
at, `lev-g0` reaches 6.32 against 6.52 — same direction, about a tenth of the
size. The pilot's configuration was never recorded, and `lev-g0` is a
re-creation of that version rather than the code that produced the number.

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

**Unofficial turned out to mean revocable.** Akamai began answering 403 to the
deployed edge Function while returning 200 to curl from a laptop — it
correlates the User-Agent against the TLS fingerprint, so there is no header to
set. The whole app went blank rather than degraded: "Nothing to show yet" on
the front page, because a survivor pick needs a slate and there was no other
way to get one.

So there are two sources now. `deadpool/src/engine/nflverse.js` reads
[nflverse's `games.csv`](https://github.com/nflverse/nfldata) — the same file
the backtester has used all along — and both `/api/week` and `/api/season` fall
back to it when ESPN refuses, or answers with no games in it. It carries the
fixtures and the closing line and no live state, which is everything a pick is
made from and nothing you would follow a Sunday with; the response says which
source answered and the app prints "Closing line as of … — ESPN unavailable"
rather than presenting it as live.

`models/win_prob.py` builds a per-team, per-week win probability table down a
four-rung ladder, tagging each row with its `source` so callers know how much
to trust it: ESPN's own figure, then the **de-vigged moneyline pair**, then a
spread estimate, then nothing.

The moneyline rung closed a hole — both prices were parsed, carried on the
model and asserted in the tests, and no scoring path had ever read either one,
so the sharpest number a book publishes was in hand and discarded. A moneyline
is a price on the outcome; a spread is a price on the margin that then has to be
converted into one.

The spread rung is a logistic fitted to 3,018 completed games (nflverse,
2015–2025). It replaced `50 + spread × 1.2`, which scores a game laid at
fourteen points at 66.8% where the favourite won 88.1% of the 42 such games —
an error big enough to invert hold-versus-spend decisions rather than merely
mislabel a pick. Refitted on 2015–2021 and scored on 2022–2025 the curve beats
the old rule on Brier score, 0.2098 against 0.2260, where 0.25 is a coin flip.
`python3 scripts/calibrate.py spread` prints both, and the decile table that
says where it is still wrong. The constants are written down
rather than fitted at run time, because nothing in the suite may touch the
network.

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
    engine/field.js    the observed field: exact inventories, past popularity
    engine/calendar.js the .ics export and the subscribable deadline feed
    engine/payout.js   the pot, a fair share, and what the ratings assume
  src/store/         localStorage; the pick log is the only truth
  src/views/         five screens
main.py            the terminal pipeline
report.py          the read-only pipeline both front ends share
data/ models/ picker/ strategy/ state/    the engine
  models/win_prob.py       the source ladder, de-vigging, the tie
  models/field_forecast.py how a field distributes itself over a board
  models/payout.py         deepest-splits: what a finished season is worth
  models/pot_share_ev.py   one week's expected pot share, exactly
  models/joint_pot_share.py  the same for a holding of several entries
fixtures/          frozen weeks + the Python's recorded output
test/              node --test: parity, store, engine contract, formatting
tests/             pytest: the Python
scripts/           authoring and check tools
  scripts/field.py         250 simulated opponents, with inventories
  scripts/synth.py         whole seasons, fitted to the real distribution
  scripts/backtest.py      the replay, one entry or two, real or synthetic
```

`models/` is pure and never fetches. `scripts/` is where anything that *may*
fetch lives, and the rule the suite holds to is that it never causes one: a
test reaching into `scripts/backtest.py` imports it inside the test and skips
when the results cache is absent, which is what keeps CI honest. `field.py`
and `synth.py` sit there because they are evaluation scaffolding rather than
engine, and they touch no network at all — so the suite imports them
normally.

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

## Reading the pool sheet from a link

`/api/pool` reads the pool's Google Sheet directly, so the field's picks can
arrive without a manual export each week.

**The Pool screen draws it, and `ctx.field` carries it into the engine.** The
screen leads with scarcity rather than popularity — how many surviving entries
can still take each team, ascending — because that number is exact and it is
the one that decides a late week. By Week 13 everybody agrees who is good and
most of the field has already spent them; what matters is who is left to you
and not to them.

`scripts/read-pool.py` still reads a downloaded CSV from the terminal, with no
network at all, and is the way to check a sheet's shape before deploying it.

Set **`POOL_SHEET_URL`** in the Cloudflare Pages environment — either the whole
CSV-export URL or just the spreadsheet ID, which is expanded to the
link-viewable form:

```
1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms
https://docs.google.com/spreadsheets/d/<id>/export?format=csv     # link-viewable
https://docs.google.com/spreadsheets/d/e/<pubid>/pub?output=csv   # published to web
```

It is an environment variable rather than a committed constant for the reason
every other credential here is: `deadpool/` is deployed from the repository, so
a URL written into the source is a URL published with it.

The browser never calls Google. `connect-src 'self'` forbids it and Google
sends no `Access-Control-Allow-Origin` anyway, so `functions/api/pool.js`
fetches at the edge exactly as `/api/week` does for ESPN — which also means
Google never learns who opened the app.

**Three things about this are assumptions, and none has met a real sheet.** The
layout (one row per entry, a column per week, headings like "Team Name" and
"Week 1 Pick"); the sharing mode (assumed "anyone with the link can view"); and
that no credentials are needed. They are written down together at the top of
`functions/api/pool.js` so the real export can correct all three in one pass
rather than failing one at a time. Nothing in the code depends on which sharing
mode it turns out to be — only the URL does.

**The failure it guards is the dangerous one.** A sheet that is *not* shared
does not return 401. It returns **200 with an HTML sign-in page**, which a CSV
parser reads as one nonsense row — reaching the app as a pool of zero entries
and the words "the sheet is empty", which somebody believes. The response is
checked for being HTML before it is parsed, and that case gets its own message
naming the likely cause.

`scripts/read-pool.py` does the same job from the terminal against a
downloaded CSV, and needs no network at all.

## The pool's own pick sheet

Picks in this pool become visible after kickoff each week, exported from a
Google Sheet as one row per entry and a column per week:

```
Team Name        , Elimination Status , Week 1 Pick , Week 2 Pick , ...
Gridiron Gang    , Alive              , KC          , Bills       , ...
Ship of Theseus  , Out - Week 3       , Chiefs      , SF          , ...
```

```bash
python3 scripts/read-pool.py picks.csv
python3 scripts/read-pool.py picks.csv --week 3
```

Two things it produces, with very different standing. **Inventories are
exact** — after a week is visible you know precisely which teams each survivor
can no longer pick, and nothing is estimated. **Popularity is observed for past
weeks only**, because you never see the current week before deciding; what past
weeks buy is fitting the prediction against *this* field instead of a national
average from pools with different people.

`Team Name` is the entry's name, not an NFL team. The heading collides with
what the rest of this codebase means by "team", and reading it the other way
would produce a field of 250 franchises that do not exist.

**A name that resolves to the wrong team is silent**, so ambiguity is refused
rather than guessed: `LA` has been two teams since 2017 and `NY` always was, so
both raise instead of picking whichever came first in a dictionary. The four
abbreviations the parity suite already guards get the same care — a sheet
filled in by a person writes WAS, LA, LVR and JAC where ESPN writes WSH, LAR,
LV and JAX.

Nothing hardcodes eighteen weeks: a column appears each week and the reader
discovers them from the headings.

## Measuring a change

The suite proves the port matches the Python. It says nothing about whether
either is any good — the fixture season is synthetic and has no results in it.
`scripts/backtest.py` is what settles that: it replays whole seasons against
real outcomes from nflverse and reports how many weeks an entry lasted.

```bash
python3 scripts/backtest.py                                # every strategy, 2015-2024
python3 scripts/backtest.py --compare-win-prob --starts 8  # before vs after a scoring change
```

It fetches, so it lives in `scripts/` and is never imported by the suite —
same rule as every other authoring tool here.

**It prints two paired tables, and the second one is why.** Every conclusion
this harness reached for a long time came from a paired t on *pot share* —
what the pool pays, and the worst-behaved number here. It is zero in about 96%
of seasons, so most *pairs* of strategies tie in most seasons: over 10,000
seasons `distinct` against `joint` had 674 seasons where either was ahead and
9,326 ties. A t computed there rests on the 674.

That, not the sample size, is why larger runs kept failing to settle that
comparison — the metric discards nineteen seasons in twenty before the
statistic sees them. So the same run now also pairs on **weeks survived**,
which is a real number every season and was already being computed as the
`deepest` column's grand mean. Its informative counts run from 1,472 to 6,923
where pot share's run from 333 to 1,701.

Both, rather than a swap. Where they agree — `distinct` over `joint` at 2.43 on
money and 3.36 on depth — two metrics with different noise beat either one at
twice the sample. Where they disagree, that *is* the finding: a pair separating
on depth but not money survived longer without converting it, and a pair
separating on money but not depth lasted just as long and shared with fewer
people. Each table prints its informative-season range so a small t can be read
against the sample it actually had.

**Read its output with the variance in mind.** A survivor season is one entry
making at most eighteen decisions, and luck dominates. When the win-probability
work was measured this way, all four strategies improved — and not one of them
by more than two standard errors over 80 runs. Being right about the numbers
was still worth doing, because the app *shows* them; but nothing here has yet
demonstrated a measured edge, and a strategy change should not be described as
one on the strength of ten seasons.

### Pot share, and why one entry reads zero

```bash
python3 scripts/backtest.py --pot-share
```

Weeks survived is not what the pool pays. The pot splits among whoever gets
deepest, so surviving to Week 12 is worth everything if the field died in Week
11 and nothing if half of them reached Week 14. `scripts/field.py` simulates
250 opponents — each with its own inventory, because the reason a team is cheap
in Week 14 is that most survivors already spent them — and `--pot-share` scores
against it.

On a single entry every strategy scores about **zero**, and that is the finding
rather than a bug. Your entry lasts about four weeks, which is what the
literature says a well-played entry lasts; the deepest of 249 opponents usually
goes the distance. None of the single-entry strategies models opponents, so
they pick the chalk the field picks and die in the weeks the field dies — and
being correlated with the crowd is the one thing that cannot win a large pool.

### Two entries, which is what is actually held

```bash
python3 scripts/backtest.py --entries 2                  # the real ten seasons
python3 scripts/backtest.py --entries 2 --synthetic 400  # enough of them to mean something
```

Breaking that correlation is what `models/pot_share_ev.py` and
`models/joint_pot_share.py` are for: the exact expected share of the pot for a
pick, and for a whole holding, given what the field is on. Four ways of pairing
two entries are compared — `twice` (the same strategy run twice, which produces
two identical entries and is the floor), `distinct` (the same strategy with the
first entry's pick struck off the second's inventory), `joint` (the existing
pair search) and `potshare`.

**The N you pass is the whole of how to use it, and it reverses the answer.**
Against 250 opponents both entries on the same favourite beats any split pair,
because your two entries are 0.8% of the denominator and a second survivor
really is a second share. What makes diversification pay is the *terminal*
field — `expected_perfect_entries()` is 0.87 out of 250 — and under
deepest-splits a second entry is worth **exactly zero** once the first is clear
of the field, since 2/(2+0) and 1/(1+0) are both the whole pot. Pass the field
you expect to finish against, which is what `field.terminal_field` projects.

### Synthetic seasons, because there will never be an eleventh real one

```bash
python3 scripts/synth.py 400                                    # what it generates
python3 scripts/backtest.py --entries 2 --robustness            # when the forecast is wrong
```

Ten real seasons cannot separate these strategies: two of ten pay anything at
all, so each strategy's mean rests on a single year, and replaying the same ten
from different starting weeks reuses the same outcomes. `scripts/synth.py`
generates seasons instead, with four constants fitted against 174 real
week-slates rather than chosen — the favourite's price, the best team on the
board, how often the chalk wins, and the games-per-week distribution.

The reason this is not cheating: **because the generating probabilities are
known to be correct, a gap between two strategies is a policy difference rather
than model error.** On real data a strategy can win by reading the games
better, which is a different question from how to spend an inventory over
eighteen weeks. It says nothing about whether the engine's probabilities are
any good — `calibrate.py` and the real backtest are still the only things that
do.

`--robustness` is the measurement that decides whether any of it is usable.
Everywhere else the harness hands a pot-share strategy the field's *true* pick
distribution, which is right for comparing policies and is a situation that
never occurs — nobody knows how chalky their pool is, and the first observed
picks do not arrive until Week 1 has kicked off. So the field keeps behaving
one way and the strategy is told another. A strategy whose advantage survives
only on the oracle row cannot be used, however well it scores elsewhere.

One thing the field simulation settled on its own: it reaches the historical
73%-a-week survival rate with **no carelessness modelled at all**. A field
picking favourites survives at 83% in any single week, and the gap closes
because an entry cannot keep taking the chalk it spent in September. The public
survival rate is not evidence that the public picks badly — it is evidence that
taking the best available team every week is a losing plan over a season.

## Two things worth knowing

**The fixtures are generated, not captured.** This was built somewhere that
cannot reach `site.api.espn.com`. They are written to the shape the parser
reads, which makes them fully sufficient for proving the two engines agree from
identical input — and blind to exactly one thing: ESPN renaming a field. Run
`node scripts/capture-week.mjs --week N` from a machine with network access to
replace them with real captures.

**A tie is not a loss here, and the engine knows.** This pool's rule is
confirmed: a tie advances you. `DEFAULT_TIE_IS_LOSS` is `False`, and both
engines fold the tie into the advance probability rather than dropping it —
which is why the two sides of a game sum to slightly *more* than 100%, and why
there is a test asserting exactly that.

The rate is measured rather than assumed: **0.215%**, from 15 ties in 6,967
games, 1999-2025. The research spec this was built from carries a formula
giving about 3.0%, which is fourteen times too high; the measurement won. It is
small enough to change no ranking and large enough that a survival figure
quoting it is right rather than optimistic, which is the standard this project
holds itself to about what it does and does not know.

The two rungs of the source ladder are folded differently and it matters.
ESPN publishes a three-way split, so its number is already unconditional and
the tie is simply **added**. A de-vigged moneyline quotes P(win | not a tie),
so it is first scaled down by `(1 - P(tie))` and only then has the tie added
back. Treating an already-unconditional figure as a conditional one would be
wrong on one rung in a way nothing downstream would surface.
