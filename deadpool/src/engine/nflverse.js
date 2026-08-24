/**
 * A second source for the schedule and the lines, so ESPN is not a single
 * point of failure.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * The app was entirely dependent on two undocumented ESPN endpoints, and when
 * Akamai began refusing the edge Function's User-Agent the whole product went
 * blank -- not degraded, blank. "Nothing to show yet" on the front page,
 * because a survivor pick needs a slate and there was no other way to get one.
 *
 * That is a bad shape for something whose data is a public NFL schedule.
 * nflverse publishes exactly what is needed -- every game, its date, and the
 * closing moneyline and spread -- as one CSV on GitHub, and the backtester in
 * scripts/backtest.py has been reading it all along. This is that same file,
 * parsed at the edge into the shape the engine already speaks.
 *
 * It is deliberately the *fallback* rather than the primary. ESPN carries live
 * state -- whether a game has kicked off, the score, an in-progress win
 * probability -- and this carries none of that: a row is a fixture and a
 * price. For choosing a pick before Sunday that is enough, and it is the
 * difference between a working app and a blank one.
 *
 * ── The sign convention, which is the easy thing to get wrong ───────────
 *
 * nflverse's `spread_line` is **positive when the home team is favoured**.
 * ESPN's `spread`, which models/win_prob.py reads, is **negative**. They are
 * opposite, and getting it backwards does not throw -- it recommends the
 * underdog in every game and looks like a strategy having a bad season.
 * scripts/backtest.py negates it for the same reason; so does this.
 *
 * Moneylines need no conversion: American odds are American odds.
 *
 * ── The abbreviations, which are the silent thing to get wrong ──────────
 *
 * nflverse does not write the abbreviations this app uses. It writes `LA` for
 * the Rams and `WAS` for Washington, where data/teams.js -- and therefore every
 * used-team list, every pick record and every ESPN payload -- says `LAR` and
 * `WSH`. Verified against the live file: for 2022 onwards those two are the
 * only disagreements, and the older seasons the backtester reads add `OAK`,
 * `SD` and `STL` for franchises that have since moved.
 *
 * Unmapped, the code is a string that matches nothing. It does not throw and
 * it does not look wrong: the team renders under its own abbreviation, the
 * used-team check misses it so an already-spent team is offered again, and a
 * pick recorded against `LA` can never settle against a later ESPN week that
 * calls it `LAR`. That is a corrupted pick log rather than a bad screen, and
 * it happens on the fallback path -- which is the path taken exactly when
 * ESPN is refusing and the app matters most.
 *
 * So the codes are mapped on the way in, before anything downstream sees them.
 */
const NFLVERSE_ABBR = {
  LA: 'LAR',       // nflverse's Rams
  WAS: 'WSH',      // nflverse's Commanders
  OAK: 'LV',       // Oakland, pre-2020
  SD: 'LAC',       // San Diego, pre-2017
  STL: 'LAR',      // St. Louis, pre-2016
};

/** nflverse's code for a franchise, in this app's spelling. */
const abbr = (code) => NFLVERSE_ABBR[code] ?? code;

/** Row order is not guaranteed, so columns are found by name. */
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { out.push(field); field = ''; continue; }
    field += c;
  }
  out.push(field);
  return out;
}

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const REGULAR_SEASON = 'REG';

/**
 * The final score of a played row, in the shape ESPN's parser produces.
 *
 * One resolver reads results off either source, so the two have to agree about
 * more than field names. Two conventions are being matched here deliberately:
 *
 *   - `winner` is **false on both sides of a tie**, which is what ESPN sends.
 *     A tie is told apart by the scores being equal, never by this field, so
 *     nothing downstream may treat `winner === false` as "lost".
 *   - A row with no score is `null` on both, not `0`. A scoreless row is a
 *     game that has not been played, and 0-0 is a real result somebody could
 *     be eliminated by.
 *
 * `result` is the margin and is preferred where the score columns are absent,
 * because older rows in this file carry one and not the other.
 */
function finalScore(r, col) {
  const home = col.home_score >= 0 ? num(r[col.home_score]) : null;
  const away = col.away_score >= 0 ? num(r[col.away_score]) : null;
  const margin = home !== null && away !== null
    ? home - away
    : (col.result >= 0 ? num(r[col.result]) : null);

  if (margin === null) {
    return { home: { score: home, winner: null }, away: { score: away, winner: null } };
  }
  return {
    home: { score: home, winner: margin > 0 },
    away: { score: away, winner: margin < 0 },
  };
}

/**
 * `gameday` + `gametime` as a real instant.
 *
 * The trap: nflverse's `gametime` is **Eastern wall time** — a Thursday night
 * game reads `20:20` — and stamping that with a `Z` puts every kickoff four
 * hours early. Nothing throws; `nextLock` just counts down to the wrong
 * moment and `ttlFor` calls the week finished while it is still being played.
 *
 * The offset cannot be hard-coded, because a season spans the November
 * changeover: September is UTC-4 and December is UTC-5. So the zone is asked,
 * by formatting a provisional instant in it and measuring how far the answer
 * moved. Workers ship a full ICU, so `America/New_York` resolves.
 *
 * The two-step is exact everywhere except within an hour of a transition
 * itself, which falls at 2am on a Sunday in March and November — no NFL game
 * has ever kicked off there.
 */
function easternInstant(day, time) {
  if (!day) return null;
  if (!time) return `${day}T00:00:00Z`;      // older rows carry no time
  const provisional = Date.parse(`${day}T${time}:00Z`);
  if (!Number.isFinite(provisional)) return null;
  const shifted = provisional + easternOffsetMs(provisional);
  return Number.isFinite(shifted) ? new Date(shifted).toISOString() : null;
}

/** How far behind UTC New York is at `t`, in ms. 4h in September, 5h in December. */
function easternOffsetMs(t) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(t));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Number.isFinite(asUtc) ? t - asUtc : 0;
  } catch {
    // No ICU, somehow. Better to be four hours early than to lose the date.
    return 0;
  }
}


/**
 * The rows for one season, already split, with the header's column indices.
 *
 * All three readers below want the same thing — every regular-season row of
 * one season — and the file is every season since 1999, about 7,300 rows of
 * it. Splitting all of them to find sixteen is most of the work, so the season
 * is matched as a string prefix first.
 *
 * That prefix test is a real property of this file rather than a guess:
 * `game_id` is the first column and is `YYYY_WW_AWAY_HOME`, so its first four
 * characters are the season on every row. Checked, on every row of the shipped
 * file. It is verified again per row against the `season` column, so a file
 * that stopped holding to it would return nothing rather than the wrong year.
 */
function seasonRows(csv, season) {
  const lines = (csv || '').split('\n');
  if (lines.length < 2) return null;

  const header = splitCsvLine(lines[0]);
  const col = {};
  for (const name of [
    'season', 'game_type', 'week', 'gameday', 'gametime', 'home_team', 'away_team',
    'spread_line', 'home_moneyline', 'away_moneyline', 'game_id', 'result',
    'home_score', 'away_score',
  ]) col[name] = header.indexOf(name);
  if (col.season < 0 || col.week < 0 || col.home_team < 0 || col.away_team < 0) return null;

  const want = String(season);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.slice(0, 4) !== want) continue;
    const r = splitCsvLine(line);
    if (Number(r[col.season]) !== Number(season)) continue;
    if (col.game_type >= 0 && r[col.game_type] !== REGULAR_SEASON) continue;
    rows.push(r);
  }
  return { rows, col };
}

/**
 * One week of games from the nflverse CSV, in the engine's own shape.
 *
 * Returns `[]` rather than throwing when the season or week is absent — a
 * schedule that does not go that far is a fact about the file, not an error,
 * and the caller has a better message for it than a stack trace.
 */
export function parseNflverseWeek(csv, season, week) {
  const found = seasonRows(csv, season);
  if (!found) return [];
  const { rows, col } = found;

  const out = [];
  for (const r of rows) {
    if (Number(r[col.week]) !== Number(week)) continue;

    const spread = num(r[col.spread_line]);
    const home = abbr(r[col.home_team]);
    const away = abbr(r[col.away_team]);
    const date = col.gameday >= 0 ? r[col.gameday] : null;
    const time = col.gametime >= 0 ? r[col.gametime] : null;
    const id = col.game_id >= 0 ? r[col.game_id] : `${season}_${week}_${away}_${home}`;
    const final = finalScore(r, col);

    out.push({
      eventId: id,
      competitionId: id,
      week: Number(week),
      seasonYear: Number(season),
      seasonType: 2,
      // Converted out of Eastern rather than stamped Z -- see easternInstant.
      // A row with no time at all becomes midnight UTC, which is early rather
      // than absent: a null here drops the game out of nextLock() entirely, so
      // the pick would lock with no countdown at all.
      startDate: easternInstant(date, time),
      // A row with a result is a game that has been played. Anything other
      // than 'pre' is treated downstream as no longer pickable, which is the
      // behaviour wanted: the file is refreshed daily, so a finished game
      // must not stay selectable.
      state: col.result >= 0 && r[col.result] !== '' ? 'post' : 'pre',
      // The final score, carried rather than dropped.
      //
      // These columns were read only to decide `state` and then thrown away,
      // which left every finished game on this source looking like one whose
      // outcome nobody knows: `winner` null on both sides. Nothing needed it
      // until results began settling themselves — and this is the source that
      // matters for that, because ESPN is the one answering 403 to the edge.
      //
      // `winner` is false on BOTH sides of a tie, which is ESPN's convention
      // and is what lets one resolver read either source. A tie is told from a
      // loss by the scores being equal, never by this field.
      home: { id: null, abbreviation: home, displayName: home, shortName: home, ...final.home, record: null },
      away: { id: null, abbreviation: away, displayName: away, shortName: away, ...final.away, record: null },
      // No live win probability in this file. Null rather than a guess: the
      // source ladder in win-prob.js falls to the moneyline, which is here.
      probability: null,
      odds: (spread === null && num(r[col.home_moneyline]) === null) ? null : {
        provider: 'nflverse',
        details: spread === null ? null
          : `${spread > 0 ? home : away} ${spread > 0 ? -spread : spread}`,
        // Negated. Both conventions are signed relative to the HOME team and
        // they point opposite ways: nflverse is positive when home is
        // favoured, ESPN negative. So an away favourite comes out positive
        // here, which is what estimateWinPctFromSpread expects.
        spread: spread === null ? null : -spread,
        overUnder: null,
        homeMoneyline: num(r[col.home_moneyline]),
        awayMoneyline: num(r[col.away_moneyline]),
        favoriteAbbreviation: spread === null ? null : (spread > 0 ? home : away),
      },
    });
  }
  return out;
}

/** Which weeks the file actually covers for a season, so a caller can say so. */
export function nflverseWeeks(csv, season) {
  const found = seasonRows(csv, season);
  if (!found) return [];
  const weeks = new Set();
  for (const r of found.rows) {
    const w = Number(r[found.col.week]);
    if (Number.isFinite(w)) weeks.add(w);
  }
  return [...weeks].sort((a, b) => a - b);
}


/**
 * Which week is on, from the schedule alone.
 *
 * ESPN's scoreboard says which week it considers current, and without it the
 * app has to work that out. The rule is the one a person uses: the earliest
 * week whose last game has not finished. That last game is Monday night, so
 * the board stays on the week being played right through it and turns over in
 * the small hours of Tuesday, which is where the next set of picks opens.
 *
 * The kickoffs are converted out of Eastern first. Reading `gameday` as a
 * bare UTC midnight instead — which is the obvious shortcut, and was the
 * first version of this — ends the week at 8pm Eastern on its own last day,
 * so an app open during Sunday Night Football has already moved on to next
 * week's board.
 *
 * Returns null when the season has not started or is over, and the caller
 * says so rather than guessing a week that has no games.
 *
 * `now` is required rather than defaulted, because nothing under
 * `src/engine/` may read a clock — test/engine.test.js enforces it, and the
 * reason is that the Python and the browser have to be replayable against each
 * other. A default here would be the one exception that makes the next one
 * look acceptable. The edge Function has a clock and passes it.
 */
export function currentWeekFrom(csv, season, now) {
  if (!Number.isFinite(now)) throw new TypeError('currentWeekFrom needs the current time — the engine has no clock');
  const found = seasonRows(csv, season);
  if (!found || found.col.gameday < 0) return null;
  const { rows, col } = found;

  const ends = new Map();
  for (const r of rows) {
    const w = Number(r[col.week]);
    // A row with no time is pre-2000 and cannot be the current season, but it
    // must not shorten a week either: treat it as the latest a game starts.
    const t = Date.parse(easternInstant(r[col.gameday], (col.gametime >= 0 && r[col.gametime]) || '23:00') || '');
    if (!Number.isFinite(w) || !Number.isFinite(t)) continue;
    ends.set(w, Math.max(ends.get(w) ?? -Infinity, t + GAME_MS));
  }
  if (!ends.size) return null;

  const weeks = [...ends.keys()].sort((a, b) => a - b);
  for (const w of weeks) {
    if (now <= ends.get(w)) return w;
  }
  return null;   // the season is behind us
}

/** Long enough that a game plus overtime is over, short enough not to eat Tuesday. */
const GAME_MS = 6 * 3600 * 1000;


/**
 * Which season year it is, when nobody said.
 *
 * Not the calendar year: the 2026 season's last regular-season week falls in
 * January 2027, so a bare `getUTCFullYear()` in January asks the file for a
 * season that has not been scheduled yet and gets an empty board back — in
 * the middle of the weeks that decide a pool.
 *
 * March is the boundary rather than anything cleverer. The league year turns
 * over in mid-March and nflverse has the next schedule by May, so anything
 * from March on belongs to the year it is in, and January and February belong
 * to the year before. No NFL game is played in either half's dead zone, so
 * nothing hinges on the exact day.
 *
 * `now` is required, for the same reason it is on currentWeekFrom above.
 */
export function currentSeason(now) {
  if (!Number.isFinite(now)) throw new TypeError('currentSeason needs the current time — the engine has no clock');
  const d = new Date(now);
  return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}
