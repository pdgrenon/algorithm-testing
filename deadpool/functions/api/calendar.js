/**
 * GET /api/calendar[?season=]  →  text/calendar
 *
 * The season's pick deadlines, as a calendar anybody can subscribe to.
 *
 * ── What this is, stated precisely, because the obvious reading is wrong ──
 *
 * It carries **when each week closes** and nothing else. No picks, no
 * recommendation, no inventory, no token, no idea who is asking. One URL
 * serves every person in every pool.
 *
 * That sounds like the weaker half of the feature and is the half that works.
 * The reasoning is in `planSeasonDeadlines` in src/engine/calendar.js and is
 * worth reading before anyone is tempted to "improve" this by putting a pick
 * in it; the short version is two facts that point the same way:
 *
 *   1. A calendar client refreshes a subscription on **its** schedule — hours
 *      to a day, Google's being the worst and uncontrollable. A deadline is
 *      known months ahead and cannot go stale at any refresh interval. A
 *      recommendation decays in hours, so a feed carrying one would show
 *      Wednesday's answer on Sunday morning, confidently.
 *   2. A personalised feed must know your picks, which means a server holding
 *      them at a URL fetchable by anyone who learns it. That is the whole
 *      local-first property, spent on the half that does not work.
 *
 * The alarm's job is to make you open the app, where the recommendation is
 * live. It does that without knowing anything about you.
 *
 * ── Why it is generated rather than a static file ───────────────────────
 *
 * Because "remaining" moves. Regenerating per request means a fetch in Week 9
 * gets Weeks 9-18 and not a season of past reminders, and it means a schedule
 * change reaches subscribers without anybody republishing anything. That is
 * also the one respect in which a subscription genuinely beats the download in
 * Settings: the download is frozen at export, this is as fresh as the client's
 * last poll.
 *
 * ── Caching ─────────────────────────────────────────────────────────────
 *
 * Hard, and harder than /api/season. The underlying schedule barely changes
 * and the derived answer changes even less — only when a week's first kickoff
 * moves or a week finishes. Six hours, with a long stale-while-revalidate, so
 * a hundred subscribed clients polling on their own schedules cost one
 * upstream fetch.
 */

import { parseGames, parseInlineOdds, safeGet } from '../../src/engine/espn.js';
import { parseNflverseWeek, currentSeason } from '../../src/engine/nflverse.js';
import { planSeasonDeadlines, toIcs } from '../../src/engine/calendar.js';
import { SITE_API, fetchJson, fetchNflverse, pool, bad, readParams, cached, CONCURRENCY } from './_shared.js';

const REGULAR_SEASON_WEEKS = 18;
const CALENDAR_TTL = 6 * 3600;

/**
 * A calendar response.
 *
 * Not `json()` from _shared, which sets a JSON content type — a calendar
 * client handed `application/json` ignores the body silently, which is the
 * same class of failure as everything else in this directory: it looks like
 * the feed is empty rather than like it is the wrong type.
 *
 * `Content-Disposition` is deliberately absent. With one, Safari downloads the
 * file instead of offering to subscribe, which turns a subscription back into
 * the snapshot this exists to be an alternative to.
 */
function calendar(body, { status = 200, ttl = CALENDAR_TTL } = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': `public, max-age=${ttl}, stale-while-revalidate=${Math.max(60, Math.floor(ttl / 2))}`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/** The whole season's weeks from nflverse, when ESPN will not answer. */
function weeksFromNflverse(csv, season) {
  if (!csv) return null;
  const weeks = {};
  for (let week = 1; week <= REGULAR_SEASON_WEEKS; week += 1) {
    const games = parseNflverseWeek(csv, season, week);
    if (games.length) weeks[week] = games;
  }
  return Object.keys(weeks).length ? weeks : null;
}

export async function onRequestGet({ request }) {
  const params = readParams(request.url);
  if (params.error) return bad(params.error);

  return cached(request, async () => {
    const season = params.season ?? currentSeason(Date.now());
    const seasonType = params.seasonType ?? 2;
    const numbers = Array.from({ length: REGULAR_SEASON_WEEKS }, (_, i) => i + 1);

    const results = await pool(numbers, CONCURRENCY, async (week) => {
      const query = new URLSearchParams({ week: String(week), seasontype: String(seasonType) });
      if (params.season !== null) query.set('dates', String(season));
      const scoreboard = await fetchJson(`${SITE_API}/scoreboard?${query}`);
      if (!scoreboard) return { week, games: null };
      const games = parseGames(scoreboard);
      const events = safeGet(scoreboard, ['events'], []) || [];
      games.forEach((g, i) => { g.odds = parseInlineOdds(events[i]); });
      return { week, games };
    });

    let weeks = Object.fromEntries(
      results.filter((r) => r.games && r.games.length).map((r) => [r.week, r.games]),
    );
    if (!Object.keys(weeks).length) {
      weeks = weeksFromNflverse(await fetchNflverse(), season) ?? {};
    }

    // An empty season is still a valid calendar, and is the right answer in
    // February. A subscriber keeps the subscription and it fills itself in when
    // the schedule is published; erroring would make them re-add it.
    const now = new Date();
    const body = toIcs(
      planSeasonDeadlines({ season, weeks, now }),
      { now, calendarName: `Deadpool ${season} — pick deadlines` },
    );
    return calendar(body);
  });
}
