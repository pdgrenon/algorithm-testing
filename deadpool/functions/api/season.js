/**
 * GET /api/season?season=&seasontype=
 *
 * Every week's schedule for a season, with whatever lines already exist.
 *
 * ── This is the route that fixes the lookahead ──────────────────────────
 *
 * `future_value` scores whether a team is worth holding back by comparing this
 * week's matchup against their next several. In the Python CLI it has never
 * done anything: `build_win_probability_table` is called from the test suite
 * and nowhere else, and the only fetch available returns one week — so the
 * remaining schedule came out empty, the future value came out null, the
 * penalty was flat zero, and the strategy that reads it silently behaved like
 * plain win-probability ranking.
 *
 * Nothing in the algorithm changed to fix that. It just needed to be handed
 * more than one week, and this is where that comes from.
 *
 * ── What it does NOT fetch, and why ─────────────────────────────────────
 *
 * No per-game probability requests. ESPN publishes a model close to kickoff,
 * so for week 12 in September there is nothing to get, and asking would be
 * 576 games times two requests for a set of nulls. Inline odds off the
 * scoreboard are taken where they exist, which is how far ahead the market has
 * actually priced — and how far ahead the lookahead can honestly see.
 *
 * A schedule barely changes, so this is cached hard. Eighteen upstream
 * requests, once every six hours, for everyone.
 */

import { parseGames, parseInlineOdds, safeGet } from '../../src/engine/espn.js';
import { SITE_API, fetchJson, pool, json, bad, readParams, cached, CONCURRENCY } from './_shared.js';

const REGULAR_SEASON_WEEKS = 18;
const SEASON_TTL = 6 * 3600;

export async function onRequestGet({ request }) {
  const params = readParams(request.url);
  if (params.error) return bad(params.error);

  return cached(request, async () => {
    const { season, seasonType } = params;
    const weeks = Array.from({ length: REGULAR_SEASON_WEEKS }, (_, i) => i + 1);

    const results = await pool(weeks, CONCURRENCY, async (week) => {
      const query = new URLSearchParams({ week: String(week), seasontype: String(seasonType ?? 2) });
      if (season !== null) query.set('dates', String(season));

      const scoreboard = await fetchJson(`${SITE_API}/scoreboard?${query}`);
      if (!scoreboard) return { week, games: null };

      const games = parseGames(scoreboard);
      const events = safeGet(scoreboard, ['events'], []) || [];
      games.forEach((g, i) => { g.odds = parseInlineOdds(events[i]); });
      return { week, games, season: safeGet(scoreboard, ['season', 'year']) };
    });

    const got = results.filter((r) => r.games !== null);
    if (!got.length) {
      return json({ ok: false, error: 'ESPN did not answer for any week.', source: 'upstream-failed' }, { status: 502, stale: true });
    }

    return json({
      ok: true,
      season: got[0].season ?? season,
      seasonType: seasonType ?? 2,
      // A partial season is returned rather than refused. Seventeen weeks of
      // lookahead is worth having, and the caller is told which one is absent
      // instead of being handed a gap it has to infer.
      weeks: Object.fromEntries(got.map((r) => [r.week, r.games])),
      missingWeeks: results.filter((r) => r.games === null).map((r) => r.week),
      pricedThrough: Math.max(...got.filter((r) => r.games.some((g) => g.odds)).map((r) => r.week), 0),
      fetchedAt: new Date().toISOString(),
      source: 'live',
      ttl: SEASON_TTL,
    }, { ttl: SEASON_TTL });
  });
}
