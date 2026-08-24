/**
 * GET /api/nfelo?season=
 *
 * One season of nfelo's Elo win probabilities, as `{ gameId: homeWinProb }`.
 *
 * ── Why this is a route and not a fetch from the page ───────────────────
 *
 * The same three reasons /api/week is. `raw.githubusercontent.com` sends no
 * Access-Control-Allow-Origin a browser can use for this, the file is 1.4 MB
 * of which this app reads two columns, and keeping it server-side means the
 * app keeps `connect-src 'self'` — nobody's phone tells a third party that
 * somebody opened this.
 *
 * The season filter is most of the point: 4,600 rows since 2009 become about
 * 270, and the response is a flat object of numbers measured in single-digit
 * kilobytes.
 *
 * ── Missing is normal here, unlike everywhere else ──────────────────────
 *
 * nfelo's pipeline publishes ratings as the season plays out, so a request in
 * September legitimately returns one or two weeks of a schedule that runs to
 * eighteen. That is not a degraded answer and is not reported as one. Every
 * game not in the response falls back to the market alone, which is also what
 * happens when this route fails entirely — the blend is a second opinion on
 * top of a model that works without it, so `{}` is always a valid answer.
 *
 * Cached hard, because the file behind it is regenerated about once a day.
 */

import { fetchNfelo, json, bad, readParams, cached } from './_shared.js';
import { parseNfeloSeason } from '../../src/engine/nfelo.js';
import { currentSeason } from '../../src/engine/nflverse.js';

/** Six hours. The upstream pipeline runs daily; anything shorter is noise. */
const NFELO_TTL = 6 * 3600;

export async function onRequestGet({ request }) {
  const params = readParams(request.url);
  if (params.error) return bad(params.error);

  return cached(request, async () => {
    const season = params.season ?? currentSeason(new Date());

    const csv = await fetchNfelo();
    if (csv === null) {
      // A reachability failure and a season nfelo has not started rating look
      // identical to the caller, and deliberately so: both mean "no second
      // opinion this time", and both are handled by falling back to the
      // market. What differs is that this one must not be cached, or one bad
      // minute at GitHub becomes six hours of market-only picks.
      return json(
        { ok: true, season, upstream: null, probabilities: {} },
        { ttl: 0, stale: true },
      );
    }

    const probabilities = parseNfeloSeason(csv, season);
    return json(
      {
        ok: true,
        season,
        upstream: 'nfelo',
        fetchedAt: new Date().toISOString(),
        // Named so a surface can say how much of the season is actually
        // rated, rather than leaving "the blend did nothing this week" to
        // look like a bug.
        rated: Object.keys(probabilities).length,
        probabilities,
      },
      { ttl: NFELO_TTL },
    );
  });
}
