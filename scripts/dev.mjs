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
 */
const HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
    "font-src 'self'", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'",
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'",
  ].join('; '),
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
const ROUTES = new Set(['/api/week', '/api/season', '/api/pool', '/api/calendar']);

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
    const body = url.pathname === '/api/season' ? await fixtureSeason() : await fixtureWeek(url.href);
    return new Response(`${JSON.stringify(body)}\n`, { headers: { 'Content-Type': 'application/json' } });
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
