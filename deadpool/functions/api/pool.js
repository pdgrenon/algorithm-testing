/**
 * GET /api/pool
 *
 * The pool's own pick sheet, read from a Google Sheet and parsed at the edge.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * Everything the engine believes about opponents is a prior. This is the only
 * route to observation. Picks in this pool become visible after kickoff each
 * week, so what arrives is a growing record of what the field *did* -- never
 * what it is about to do.
 *
 * Same reason as /api/week: Google's CSV export sends no
 * Access-Control-Allow-Origin, so a browser cannot call it at all, and the
 * app's `connect-src 'self'` forbids trying. The Function is same-origin, so
 * the policy is untouched and Google never learns who opened the app.
 *
 * ── Three assumptions, none of them checked against a real sheet ─────────
 *
 * Nobody has seen the actual export yet. Written down together so they can be
 * corrected in one pass rather than discovered one failure at a time:
 *
 *   1. **The layout.** One row per entry, one column per week, headed
 *      something like "Team Name", "Elimination Status", "Week 1 Pick". The
 *      parser in src/engine/pool-sheet.js accepts a range of headings, but it
 *      is a range somebody guessed.
 *   2. **The sharing mode.** Assumed "anyone with the link can view", read
 *      through `/export?format=csv`. It might be published-to-web
 *      (`/pub?output=csv`), or restricted, or not a Google Sheet at all.
 *      Nothing here depends on which: POOL_SHEET_URL is taken whole, and a
 *      bare spreadsheet ID is expanded to the link-viewable form. If the
 *      answer turns out different, the URL changes and this file does not.
 *   3. **That it is reachable without credentials.** No token is sent. A
 *      sheet that needs one fails the check below rather than half-working.
 *
 * ── The failure this guards, which is the dangerous one ─────────────────
 *
 * A Google Sheet that is *not* shared does not return 401 or 403. It returns
 * **200 with an HTML sign-in page**, which a CSV parser reads as one long
 * nonsense row rather than as an error. That would reach the app as a pool of
 * zero entries and a list of parse problems, and "the sheet is empty" is a
 * sentence somebody believes.
 *
 * So the body is checked for being HTML before it is parsed, and that case
 * gets its own status and message naming the likely cause. Preferring a loud
 * wrong answer to a quiet one is the whole posture of this codebase.
 */

import { loadPoolSheet, popularity } from '../../src/engine/pool-sheet.js';
import { USER_AGENT, FETCH_TIMEOUT_MS } from './_shared.js';

/** A bare spreadsheet ID to the link-viewable CSV export. */
function toCsvUrl(configured) {
  const value = (configured || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  // Looks like a bare ID: Google's are long and URL-safe.
  if (/^[\w-]{20,}$/.test(value)) {
    return `https://docs.google.com/spreadsheets/d/${value}/export?format=csv`;
  }
  return null;
}

/** Does this look like a sign-in page rather than a spreadsheet? */
function looksLikeHtml(text) {
  const head = text.slice(0, 400).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html');
}

function json(body, status = 200, maxAge = 300) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
    },
  });
}

export async function onRequestGet({ env }) {
  const url = toCsvUrl(env && env.POOL_SHEET_URL);
  if (!url) {
    // Not an error, and not a 404 either: "this deployment has not been given a
    // sheet" is a different answer from "this route does not exist", and a
    // caller has to be able to tell them apart to draw nothing rather than
    // draw a broken control.
    //
    // The Pool screen reads this route on every refresh, and `engineContext`
    // turns the payload into `ctx.field` — which is what `leverage` reads. So
    // `configured: false` is the answer that makes the screen say so and
    // degenerates `leverage` to `distinct`, rather than an unused branch.
    return json({ configured: false, reason: 'POOL_SHEET_URL is not set' }, 200, 60);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/csv,*/*' },
      signal: controller.signal,
      redirect: 'follow',
    });
    text = await res.text();
  } catch (err) {
    return json({ configured: true, ok: false, error: 'unreachable', detail: String(err) }, 502, 0);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return json({ configured: true, ok: false, error: 'upstream', status: res.status }, 502, 0);
  }

  if (looksLikeHtml(text)) {
    return json({
      configured: true,
      ok: false,
      error: 'not-csv',
      detail:
        'The sheet returned an HTML page rather than CSV, which is what Google '
        + 'sends when a spreadsheet is not readable without signing in. Set the '
        + "sheet to 'anyone with the link can view', or publish it to the web as CSV.",
    }, 502, 0);
  }

  const sheet = loadPoolSheet(text);
  const alive = sheet.entries.filter((e) => e.alive);
  // The latest week that has been PLAYED, which is a fact about the cells, not
  // about the headings. A sheet laid out with all eighteen columns up front —
  // the ordinary way to build one — has `weeks` full from the first day of the
  // season, so deriving this from the headings reported week 18 in week 3.
  // The Pool screen's whole premise is that it shows what happened rather than
  // what a model expects, so a heading is exactly the wrong source for it.
  const picked = sheet.entries.flatMap((e) => Object.keys(e.picks).map(Number));
  const latest = picked.length ? Math.max(...picked) : null;

  return json({
    configured: true,
    ok: true,
    fetchedAt: new Date().toISOString(),
    entries: sheet.entries.length,
    alive: alive.length,
    weeks: sheet.weeks,
    problems: sheet.problems,
    // Observed shares for every week on the sheet. This is the number the
    // popularity prior is meant to predict, and the reason to fetch at all.
    popularity: Object.fromEntries(sheet.weeks.map((w) => [w, popularity(sheet, w)])),
    // Every team each surviving entry has already SPENT -- not what is left to
    // them, which is the complement and is the caller's to take, since only the
    // caller knows the board. "Inventory" is scripts/field.py's word for this
    // exact set: `Entry.used`, and what `popularity_from_inventories` is
    // handed. So this is the observed version of the thing that file simulates.
    inventories: Object.fromEntries(
      alive.map((e) => [e.entryName, Object.values(e.picks)]),
    ),
    latestWeek: latest,
  });
}
