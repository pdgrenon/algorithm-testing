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

/**
 * How long a fallback board stays fresh.
 *
 * Fifteen minutes rather than the tiered TTL the ESPN path uses: this source
 * carries no kickoff state, so `ttlFor` has nothing to tier on, and the file
 * behind it is refreshed about once a day.
 */
const FALLBACK_TTL = 900;

/** ESPN's seasontype for the regular season, and its last week. */
const REGULAR_SEASON = 2;
const LAST_REGULAR_WEEK = 18;

/** How long a finished week may stand as the answer to "which week is it". */
const CURRENT_WEEK_OVER_TTL = 900;

/** Every game final. An empty week is not over; it is missing. */
const weekIsOver = (games) => games.length > 0 && games.every((g) => g.state === 'post');

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

    let upstream = await fetchUpstream(`${SITE_API}/scoreboard${qs ? `?${qs}` : ''}`);
    let scoreboard = upstream.body;
    let games = scoreboard ? parseGames(scoreboard) : [];

    // ── The week after a finished one ───────────────────────────────────
    //
    // Asked for no week, ESPN answers with the week *it* calls current, and it
    // keeps calling a week current for a day or two after Monday night's game
    // is final. So on Tuesday the front page showed week 4 with every game
    // over: "Board closed", "No legal pick" for both entries, while week 5
    // did not kick off until Thursday. Nothing about that board can be acted
    // on, so a finished regular-season week is never the answer to "which
    // week is it" -- the next one is.
    //
    // Only when the caller did not name a week: an explicit week is a request
    // for that week, finished or not, and settling results depends on it.
    const espnWeek = safeGet(scoreboard, ['week', 'number']);
    const espnSeason = safeGet(scoreboard, ['season', 'year']);
    if (week === null && weekIsOver(games)
        && safeGet(scoreboard, ['season', 'type']) === REGULAR_SEASON
        && Number.isInteger(espnWeek) && espnWeek < LAST_REGULAR_WEEK
        && Number.isInteger(espnSeason)) {
      const nextQs = new URLSearchParams({
        week: String(espnWeek + 1), dates: String(espnSeason), seasontype: String(REGULAR_SEASON),
      });
      const next = await fetchUpstream(`${SITE_API}/scoreboard?${nextQs}`);
      const nextGames = next.body ? parseGames(next.body) : [];
      // A failure here keeps the finished week rather than blanking the page:
      // a stale board is still a board.
      if (nextGames.length) {
        upstream = next;
        scoreboard = next.body;
        games = nextGames;
      }
    }

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
        // `ttl`, not `maxAge`. json() in _shared.js takes { status, ttl, stale }
        // and ignores anything else, so `{ maxAge: 900 }` here left this board
        // on the 300-second default — a quarter of the freshness it was written
        // to have, with nothing to say so. The word came from
        // functions/api/pool.js, which has its own json() with a maxAge
        // parameter: two helpers one word apart, and neither errors.
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
          ttl: FALLBACK_TTL,
        }, { ttl: FALLBACK_TTL });
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

    // "Which week is current" is itself an answer that changes, so the
    // unparameterised request never gets the day-long TTL a finished week
    // earns. It did: a finished week fetched on Tuesday evening was cached at
    // the edge and in the browser for 24 hours, and stayed on the front page
    // into Wednesday even after ESPN had moved on.
    // Reaching here with a finished week means the step forward above did not
    // happen (week 18, or ESPN had nothing for the next week yet), and the
    // short TTL is what lets the next try come soon.
    const ttl = week === null && weekIsOver(games) ? CURRENT_WEEK_OVER_TTL : ttlFor(games);
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
