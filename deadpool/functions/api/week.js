/**
 * GET /api/week?season=&week=&seasontype=
 *
 * One week of NFL games, normalised, with probabilities and lines attached.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * ESPN's endpoints send no Access-Control-Allow-Origin, so a browser cannot
 * call them. Not slowly, not with a workaround — at all. That alone decides
 * that there is a server-side piece, and once there is one it fixes four other
 * things:
 *
 *   * Thirty-three requests become one. The Python spends 1 + 2N — scoreboard,
 *     then probabilities and odds per game — at a self-imposed half-second
 *     floor, which is sixteen seconds of serial fetching before anything can
 *     render. Here the fan-out happens at the edge, in parallel, once for
 *     everyone.
 *   * It is better manners rather than worse. One origin behind a shared cache
 *     asks ESPN for a week far less often than N devices each asking would.
 *   * The parser stays in one place. The phone never ships a reader for
 *     somebody else's unsupported API.
 *   * The app keeps connect-src 'self'. No third party ever learns that
 *     somebody opened this.
 *
 * The response always carries `fetchedAt` and `source`, and the interface says
 * which. An app quietly showing Thursday's numbers on Sunday is worse than one
 * that admits it is offline.
 */

import { parseGames, parseProbability, parseOdds, parseInlineOdds, safeGet } from '../../src/engine/espn.js';
import { SITE_API, CORE_API, fetchJson, fetchUpstream, fetchNflverse, pool, ttlFor, json, bad, readParams, cached, CONCURRENCY } from './_shared.js';
import { parseNflverseWeek, currentWeekFrom, currentSeason } from '../../src/engine/nflverse.js';

export async function onRequestGet({ request }) {
  const params = readParams(request.url);
  if (params.error) return bad(params.error);

  return cached(request, async () => {
    const { season, week, seasonType } = params;

    const query = new URLSearchParams();
    if (week !== null) query.set('week', String(week));
    if (season !== null) query.set('dates', String(season));
    if (seasonType !== null) query.set('seasontype', String(seasonType));
    const qs = query.toString();

    const upstream = await fetchUpstream(`${SITE_API}/scoreboard${qs ? `?${qs}` : ''}`);
    const scoreboard = upstream.body;
    const games = scoreboard ? parseGames(scoreboard) : [];

    // Two failures, one symptom. A refusal is the one that happened -- Akamai
    // answering 403 to this Function while the same URL returns 200 to curl --
    // but an answer carrying no games renders identically: "Nothing to show
    // yet" on the front page, which is the thing being fixed. A regular-season
    // week with nothing in it is never a fact about the league, so it is
    // treated as a failure to answer rather than as an answer.
    if (!games.length) {
      // The second source before giving up. It carries the fixtures and the
      // market price but no live state, which is enough to choose a pick and
      // not enough to follow a Sunday — so it is the fallback rather than the
      // primary, and `source` says which one answered.
      const csv = await fetchNflverse();
      // The clock lives here rather than in the engine, which may not read one.
      const now = Date.now();
      const fallbackSeason = season ?? currentSeason(now);
      const fallbackWeek = week ?? currentWeekFrom(csv, fallbackSeason, now);
      const fallback = csv && fallbackWeek ? parseNflverseWeek(csv, fallbackSeason, fallbackWeek) : [];
      if (fallback.length) {
        return json({
          ok: true,
          // `source` is freshness -- this *was* just fetched -- and `upstream`
          // is which of the two answered. Folding them into one field turned a
          // cached fallback board back into a plain "cache" on reload, and the
          // app stopped saying the odds were not live.
          source: 'live',
          upstream: 'nflverse',
          fetchedAt: new Date().toISOString(),
          season: fallbackSeason,
          week: fallbackWeek,
          games: fallback,
          // Said plainly rather than left for the reader to infer from a
          // missing field: this source has no live win probability and no
          // kickoff state, so the app should not present it as live.
          note: 'ESPN did not answer; this is the published schedule and closing line, not live data.',
          upstreamReason: upstream.reason ?? (scoreboard ? 'empty' : null),
          upstreamStatus: upstream.status,
        }, { maxAge: 900 });
      }

      // Both sources are out. No stale copy to fall back on here — that is
      // the browser's job, and the service worker holds one. Say so plainly
      // rather than returning an empty week, which would render as "no games"
      // and read as a fact.
      //
      // `upstreamStatus` and `upstreamReason` are for whoever is fixing a
      // deployment, not for the app: `error` stays the sentence a person
      // reads. Establishing that a live upstream was *refusing* rather than
      // timing out took six round trips of guessing without them.
      return json(
        {
          ok: false,
          error: 'No game data available from either source right now. The app will use whatever it last saw.',
          source: 'upstream-failed',
          upstreamReason: upstream.reason ?? (scoreboard ? 'empty' : null),
          upstreamStatus: upstream.status,
        },
        { status: 502, stale: true },
      );
    }

    const events = safeGet(scoreboard, ['events'], []) || [];

    // The scoreboard usually carries the line inline. Taking it from there
    // turns a guaranteed request per game into an occasional one.
    games.forEach((g, i) => { g.odds = parseInlineOdds(events[i]); });

    const needOdds = games.filter((g) => !g.odds && g.eventId && g.competitionId);
    const needProb = games.filter((g) => g.eventId && g.competitionId);

    await Promise.all([
      pool(needOdds, CONCURRENCY, async (g) => {
        g.odds = parseOdds(await fetchJson(`${CORE_API}/events/${g.eventId}/competitions/${g.competitionId}/odds`));
      }),
      pool(needProb, CONCURRENCY, async (g) => {
        g.probability = parseProbability(
          await fetchJson(`${CORE_API}/events/${g.eventId}/competitions/${g.competitionId}/probabilities?limit=1`),
        );
      }),
    ]);

    const ttl = ttlFor(games);
    return json({
      ok: true,
      season: safeGet(scoreboard, ['season', 'year']),
      seasonType: safeGet(scoreboard, ['season', 'type']),
      week: safeGet(scoreboard, ['week', 'number']),
      games,
      fetchedAt: new Date().toISOString(),
      source: 'live',
      upstream: 'espn',
      ttl,
      // What the caller did not get, said out loud rather than left as an
      // absence. A game with no line and no model is a real state and the
      // board has to be able to show it as one.
      unpriced: games.filter((g) => !g.odds && !g.probability).map((g) => g.eventId),
    }, { ttl });
  });
}
