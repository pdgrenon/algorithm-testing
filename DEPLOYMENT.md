# Deploying Deadpool

Cloudflare Pages, no build step. Every file under `deadpool/` is the site, and
`deadpool/functions/` becomes the edge Functions.

## Not GitHub Pages

There *was* something to remove. `.github/workflows/weekly-report.yml` ran
`generate_report.py --out docs/index.html` on a schedule and published it to
GitHub Pages. It is gone: the app is what people open now, and a second
published surface showing the same picks is a second thing that can disagree
with the first.

`generate_report.py` and `report.py` are still here — `report.py` is the
read-only pipeline `main.py weekly` depends on, and the HTML output is a local
artifact you can still generate by hand. Nothing publishes it.

The pattern is worth refusing explicitly as well as removing, because both
sibling apps use it and reaching for it again is the obvious thing to do by
accident.

- **No `docs/`.** No build output directory at all. The app *is* the files.
- **No `.nojekyll`, no `gh-pages` workflow, no repo-subpath base.** Every URL
  is absolute-within-scope, so the app behaves identically on the custom domain
  and on a `*.pages.dev` preview.
- **GitHub Actions stays.** CI and Pages are unrelated products that share a
  name; only one is being refused. `.github/workflows/ci.yml` is what is left,
  and it deploys nothing.

## 1. Create the project

Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
**Connect to Git** → pick this repository. (It is named
`algorithm-testing` at the time of writing; Cloudflare tracks the repository by
id rather than by name, so a rename does not break an existing connection —
but it is worth re-checking the build after one rather than assuming.)

| Field                  | Value        |
| ---------------------- | ------------ |
| Framework preset       | **None**     |
| Build command          | *(empty)*    |
| Build output directory | `/`          |
| Root directory         | `deadpool`   |

The root directory is load-bearing rather than tidiness, and it was wrong here
from the commit that wrote this file until the one that fixed it. Pages
discovers `functions/` relative to the **root directory**, and this repository
has always kept it at `deadpool/functions/`. Rooted at `/`, Pages looks for
`/functions`, finds nothing, and deploys a site where every page loads and
every `/api/*` call fails — which is the failure mode to know about, because
the app degrades quietly rather than refusing to start.

Rooted at `deadpool` everything lands: `functions/` resolves, the static files
are the output directory itself, `_headers` and `_routes.json` sit where Pages
looks for them, and the Python reference implementation stays *outside* the
upload boundary — it is in the repository and never on the server — for the
stronger reason that nothing above `deadpool/` is in scope at all.

**Check it in one command after the first deploy**, because this is exactly the
kind of thing that looks fine until somebody opens the app:

```bash
curl -s https://<your-domain>/api/week | head -c 200
```

JSON means the Functions are wired. HTML, or a 404, means they are not, and the
root directory is the setting to change.

`_headers` and `_routes.json` are picked up automatically. The first carries
the Content-Security-Policy and the cache rules; the second confines the
Functions runtime to `/api/*`, so a static asset is served as a static asset
rather than going through a worker.

## 2. The custom domain

**Settings → Custom domains → Set up a domain** → `deadpool.averageideas.dev`.

Not cosmetic. `deadpool/index.html` hard-codes that origin in its canonical
link and its share tags, and `scripts/check-shipped.mjs` holds every absolute
URL in a shipped file to it. Served from the `*.pages.dev` URL alone the app
works perfectly and every share card points at a domain that is not serving it
— a link that unfurls as nothing, which is the failure mode that looks like
success.

## 3. Turn Web Analytics off — in both places

This is the one step that can silently undo the app's central claim, and the
one you cannot verify by reading the repository.

Cloudflare Pages can inject `static.cloudflareinsights.com/beacon.min.js` into
HTML responses **at the edge, after the build**. Nothing in the repository
changes. `npm run check` stays green, because every check it runs reads files
on disk and those files are still clean. The deployed page makes a third-party
request on every load anyway, from an app whose `connect-src 'self'` exists to
promise it makes none.

There are **two switches**, and turning off only the first is the trap:

1. **Web Analytics: Disabled** on the Pages project — Settings, analytics section.
2. **RUM off on the zone** — the account's Web Analytics list, where a site can
   be added by hostname independently of any Pages project.

Then confirm it against the live page rather than against the dashboard: open
`https://deadpool.averageideas.dev/`, and check the network panel shows
requests to that origin and nothing else. The CSP would refuse the beacon
anyway and log it — but a refused request is still a request that was made.

## 4. Preview deployments

Every branch push gets its own public URL carrying whatever is on that branch.
Either turn them off under **Settings → Builds & deployments → Preview
deployments → None**, or put Cloudflare Access on the `*.pages.dev` domain and
leave the custom domain open.

## 5. Access is optional, and the reason is worth knowing

Nothing personal ships in the bundle. Every pick lives in `localStorage` on the
device that made it, there is no account, and the app sends nothing anywhere.
The deployment is a copy of the app, not a copy of anybody's data — so a public
URL is a supported way to run this.

What *is* exposed is `/api/*`, which reads ESPN on behalf of whoever asks. It
takes no caller-supplied URL — the routes are an allowlist over season, week
and season type — so it cannot be turned into an open relay. It can still be
called by anyone with the address, which is why:

**Add a rate limit.** Cloudflare dashboard → Security → WAF → Rate limiting
rules, on `/api/*`. Something like 60 requests per minute per IP is far above
anything the app does (a week is one request, cached for hours) and far below
anything worth worrying about. This is the courtesy the Python's whole "being a
good API citizen" section is about, applied at the only place that can enforce
it.

## What the edge Function needs

**`/api/week` and `/api/season`: nothing.** No environment variables, no KV
namespace, no secrets. They read two public ESPN endpoints and cache the
answer.

**There is a second source, and you will probably need it.** ESPN's endpoints
are undocumented, unsupported and behind Akamai, which correlates the
User-Agent against the TLS fingerprint: curl from a laptop gets a 200 and the
edge Function gets a **403**, from the same URL, at the same moment. When that
started the whole app went blank — "Nothing to show yet" on the front page —
because a survivor pick needs a slate and there was no other way to get one.

So both routes fall back to [nflverse's
`games.csv`](https://github.com/nflverse/nfldata), which publishes every game
since 1999 with its date and the closing moneyline and spread. No
configuration, no key, no variable: it is a file on GitHub and the Function
fetches it when ESPN does not answer, or answers with no games in it.

What you lose on the fallback is live state — no in-progress win probability,
no kickoff status, no score. What you keep is the fixtures and the market
price, which is everything a pick is actually made from. The response says
which source answered (`upstream: 'espn' | 'nflverse'`) and the app prints
**"Closing line as of … — ESPN unavailable"** rather than presenting it as
live.

If both are out, the last good payload comes back from the device's own cache
and the app says it is offline.

**`/api/pool`: one variable, and it is optional.** Set `POOL_SHEET_URL` under
**Settings → Environment variables** to read the pool's pick sheet — either the
whole CSV-export URL or just the spreadsheet ID:

```
1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms
https://docs.google.com/spreadsheets/d/<id>/export?format=csv     # link-viewable
https://docs.google.com/spreadsheets/d/e/<pubid>/pub?output=csv   # published to web
```

An environment variable rather than a committed constant because `deadpool/` is
deployed from the repository, so a URL written into the source is a URL
published with it. Unset, the endpoint answers `configured: false`, which is a
different answer from "no such route" and is what lets a caller draw nothing
rather than a broken control.

**The app reads this route on every refresh.** The Pool screen is drawn from
it — how many entries are still alive, and how many of them can still take each
team — and `engineContext()` turns the same payload into `ctx.field`, which is
what `leverage` reads. So setting `POOL_SHEET_URL` is the difference between a
Pool screen with a field on it and one that says no sheet is configured, and
between `leverage` having something to be leveraged against and degenerating to
`distinct`. `scripts/read-pool.py` reads a downloaded CSV from the terminal
with no network at all, which is the way to check a sheet's shape before
setting the variable.

The sheet has to be readable without signing in. One that is not returns **200
with an HTML sign-in page**, not a 401 — the Function checks for that and says
so, because a CSV parser reads it as an empty pool and "the sheet is empty" is
a sentence somebody believes.

## Checking a deployment

```bash
curl -sI https://deadpool.averageideas.dev/ | grep -i content-security-policy
curl -s  https://deadpool.averageideas.dev/api/week | head -c 200
```

The first should show `connect-src 'self'` and no `unsafe-inline` anywhere. The
second should be JSON with `"ok":true` and a `fetchedAt`. If the second is slow
on the first call and fast afterwards, the edge cache is working.
