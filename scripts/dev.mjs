/**
 * A local server for the app, including the edge Functions.
 *
 * Zero dependencies, because `dependencies` is empty and should stay that way.
 * It imports the Function modules directly and calls their onRequestGet with a
 * real Request — Pages Functions are written against the Web platform's
 * Request and Response, and Node has both, so this is the actual handler
 * rather than a stand-in for it.
 *
 *   node scripts/dev.mjs                 serve, proxying to ESPN
 *   node scripts/dev.mjs --fixtures      serve the frozen fixtures instead
 *
 * `--fixtures` is not only for a machine without network access. It makes the
 * whole app deterministic — the same board, the same recommendations, every
 * time — which is what a screenshot pass needs, and it exercises the awkward
 * weeks (a relaxed floor, games already under way) that a live Tuesday never
 * shows you.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'deadpool');
const PORT = Number(process.env.PORT ?? 8787);
const USE_FIXTURES = process.argv.includes('--fixtures');
const FIXTURE = process.argv.find((a) => a.startsWith('--week='))?.split('=')[1] ?? null;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * The security headers, served locally too.
 *
 * Not decoration: a page rendered without its own CSP is a page whose CSP
 * nothing has tested, and the classic way to find out is a deployed app whose
 * bars have no width because style-src refused an inline attribute. Serving
 * the real policy here means that fails on this machine instead.
 *
 * Read out of `deadpool/_headers` rather than written down again. It was a
 * third hand-maintained copy — `_headers` for production, a `<meta>` in
 * index.html, and this — and nothing in the repository compared them, so they
 * agreed only for as long as somebody remembered, while the CI browser job
 * leans on this one being the real thing. Everything else here derives rather
 * than duplicates: `stamp-sw` from disk, `check-palette` from the stylesheet's
 * own comments, `gen-golden` from the oracle. This now does the same, and
 * `check-shipped` holds the `<meta>` copy to it.
 */
function policyFromHeaders() {
  const text = readFileSync(join(SITE, '_headers'), 'utf8');
  const line = text.split('\n').find((l) => /^\s*Content-Security-Policy\s*:/i.test(l));
  if (!line) throw new Error('no Content-Security-Policy in deadpool/_headers');
  return line.slice(line.indexOf(':') + 1).trim();
}

const HEADERS = {
  'Content-Security-Policy': policyFromHeaders(),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

/* ------------------------------------------------------------- fixtures -- */

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

async function fixtureWeek(url) {
  const name = FIXTURE ?? 'season-2026';
  const raw = await readJson(join(ROOT, 'fixtures/weeks', `${name}.json`));
  const wanted = Number(new URL(url).searchParams.get('week'));

  let week; let bundle;
  if (raw.weeks) {
    week = wanted || 3;
    bundle = raw.weeks[week];
  } else {
    week = raw.meta.week;
    bundle = raw;
  }
  if (!bundle) return { ok: false, error: `no week ${week} in ${name}` };

  const { parseGames, parseProbability, parseOdds } = await import(new URL('../deadpool/src/engine/espn.js', import.meta.url));
  const games = parseGames(bundle.scoreboard);
  for (const g of games) {
    g.probability = parseProbability(bundle.probabilities[g.eventId] ?? null);
    g.odds = parseOdds(bundle.odds[g.eventId] ?? null);
  }
  return {
    ok: true, season: raw.meta.season, seasonType: raw.meta.seasonType, week,
    games, fetchedAt: new Date().toISOString(), source: 'live', ttl: 300, unpriced: [],
  };
}

/**
 * The synthetic nfelo table, as /api/nfelo answers it.
 *
 * Its own fixture file rather than a slice of the week bundles, because it is
 * a different upstream with a different shape and its *absences* are part of
 * what it has to reproduce -- week 18 unrated, scattered games missing. See
 * scripts/make-fixtures.mjs.
 */
async function fixtureNfelo() {
  const raw = await readJson(join(ROOT, 'fixtures/weeks/nfelo-2026.json'));
  return {
    ok: true,
    season: raw.season,
    upstream: 'nfelo',
    fetchedAt: new Date().toISOString(),
    rated: Object.keys(raw.probabilities).length,
    probabilities: raw.probabilities,
  };
}

async function fixtureSeason() {
  const raw = await readJson(join(ROOT, 'fixtures/weeks/season-2026.json'));
  const { parseGames, parseOdds } = await import(new URL('../deadpool/src/engine/espn.js', import.meta.url));
  const weeks = {};
  for (const [w, bundle] of Object.entries(raw.weeks)) {
    const games = parseGames(bundle.scoreboard);
    // Only the lines, matching what the real season route can actually get:
    // ESPN publishes a model close to kickoff, so a week in the future has
    // odds at best and nothing at worst.
    for (const g of games) g.odds = parseOdds({ items: bundle.odds[g.eventId]?.items ?? [] });
    weeks[w] = games;
  }
  return { ok: true, season: raw.meta.season, seasonType: 2, weeks, missingWeeks: [], pricedThrough: 18, fetchedAt: new Date().toISOString(), source: 'live', ttl: 21600 };
}

/* -------------------------------------------------------------- serving -- */

/**
 * The routes Pages would serve, and nothing else.
 *
 * Matched exactly. Anything under /api/ that was not /api/season used to fall
 * through to the week handler, so `/api/pool` -- and `/api/nonsense` -- came
 * back as a board of games. A dev server whose whole claim is that it runs the
 * real handlers has to route like the real thing too, or the first person to
 * wire up the pool sheet locally debugs a week payload.
 */
const ROUTES = new Set(['/api/week', '/api/season', '/api/pool', '/api/calendar', '/api/nfelo']);

async function handleApi(url) {
  if (!ROUTES.has(url.pathname)) {
    return new Response(`${JSON.stringify({ ok: false, error: `no route ${url.pathname}` })}\n`,
      { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  // The pool sheet has no ESPN dependency and no fixture: it reads whatever
  // POOL_SHEET_URL points at, or answers `configured: false`. That is the real
  // handler's behaviour in both modes, so it gets the real handler in both.
  // The calendar feed is derived from the schedule and nothing else, so it
  // gets the real handler in both modes exactly as /api/pool does -- against
  // fixtures it will simply find no live ESPN and fall through to nflverse,
  // which is the same path the deployed one takes today.
  if (url.pathname === '/api/calendar') {
    const mod = await import(new URL('../deadpool/functions/api/calendar.js', import.meta.url));
    return mod.onRequestGet({ request: new Request(url.href, { method: 'GET' }), env: process.env });
  }

  if (url.pathname === '/api/pool') {
    const mod = await import(new URL('../deadpool/functions/api/pool.js', import.meta.url));
    return mod.onRequestGet({ request: new Request(url.href, { method: 'GET' }), env: process.env });
  }

  if (USE_FIXTURES) {
    let body;
    if (url.pathname === '/api/season') body = await fixtureSeason();
    else if (url.pathname === '/api/nfelo') body = await fixtureNfelo();
    else body = await fixtureWeek(url.href);
    return new Response(`${JSON.stringify(body)}\n`, { headers: { 'Content-Type': 'application/json' } });
  }

  if (url.pathname === '/api/nfelo') {
    const mod = await import(new URL('../deadpool/functions/api/nfelo.js', import.meta.url));
    return mod.onRequestGet({ request: new Request(url.href, { method: 'GET' }) });
  }

  const which = url.pathname === '/api/season' ? 'season' : 'week';
  const mod = await import(new URL(`../deadpool/functions/api/${which}.js`, import.meta.url));
  return mod.onRequestGet({ request: new Request(url.href, { method: 'GET' }) });
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      const out = await handleApi(url);
      const buf = Buffer.from(await out.arrayBuffer());
      res.writeHead(out.status, { ...Object.fromEntries(out.headers), ...HEADERS });
      return res.end(buf);
    }

    // normalize() before joining, so a traversal in the request cannot climb
    // out of the site directory.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(SITE, rel);
    const info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) file = join(SITE, 'index.html');

    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...HEADERS,
    });
    return res.end(body);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...HEADERS });
    return res.end(`not found: ${url.pathname}\n`);
  }
}).listen(PORT, () => {
  console.log(`deadpool → http://localhost:${PORT}${USE_FIXTURES ? `  (fixtures${FIXTURE ? `: ${FIXTURE}` : ''})` : '  (live ESPN)'}`);
});
