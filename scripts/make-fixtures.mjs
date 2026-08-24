/**
 * Generate the frozen ESPN-shaped fixtures the parity suite runs on.
 *
 * ── Why these are synthetic ─────────────────────────────────────────────
 *
 * They should be real captures, and `scripts/capture-week.mjs` is how you make
 * them: run it from a machine that can reach ESPN and it writes a bundle in
 * exactly this shape. It could not be run here — this environment's network
 * policy refuses site.api.espn.com — so these are generated instead, built to
 * the shape the parser actually reads rather than to a guess at it.
 *
 * That is a weaker fixture in one specific way and no others. It cannot catch
 * ESPN renaming a field, because it is written from the same understanding of
 * the response that the parser has. It is fully sufficient for the thing these
 * fixtures exist for, which is proving the JavaScript engine and the Python
 * engine reach the same answer from identical input — and it is *better* than
 * a real week at that, because a real week does not contain a tie in the joint
 * objective, a board where nothing clears the floor, or a game ESPN has not
 * priced. All three are in here on purpose.
 *
 * Everything is deterministic. There is no Math.random and no clock: team
 * strength, the schedule, the byes and the lines all come out of one seeded
 * generator, so re-running this produces byte-identical files and a diff means
 * somebody changed the generator.
 *
 *   node scripts/make-fixtures.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEAMS } from '../deadpool/src/data/teams.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures/weeks');

const SEASON = 2026;
const SEASON_TYPE = 2;
const WEEKS = 18;
// Week 1 Thursday: the Thursday after Labor Day, which in 2026 is 7 September.
const WEEK1_THURSDAY = Date.UTC(2026, 8, 10, 0, 0, 0);

/** A small LCG, so a fixture is a function of its seed and nothing else. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/* ------------------------------------------------------------ the league -- */

// One rating per team, spread over about 14 points of spread from best to
// worst — roughly the real range, and wide enough that future-value has
// something to reason about rather than a flat field.
const rate = rng(20260910);
const RATINGS = new Map(TEAMS.map((t) => [t.abbr, Math.round((rate() * 14 - 7) * 10) / 10]));

// Four teams per bye week, weeks 5 through 12: 32 teams, 8 weeks.
const BYES = new Map();
{
  const order = TEAMS.map((t) => t.abbr);
  const shuffle = rng(77);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(shuffle() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let w = 5; w <= 12; w += 1) BYES.set(w, order.slice((w - 5) * 4, (w - 5) * 4 + 4));
}

const HOME_FIELD = 2.0;   // points, the long-standing rule of thumb

/** Pair up whoever is playing, deterministically and differently each week. */
function matchupsFor(week) {
  const bye = new Set(BYES.get(week) ?? []);
  const playing = TEAMS.map((t) => t.abbr).filter((a) => !bye.has(a));
  // A rotation rather than a shuffle, so a team meets different opponents
  // across the season and the lookahead has real variation to find.
  const rotated = playing
    .map((abbr, i) => ({ abbr, k: (i * 7 + week * 13) % playing.length }))
    .sort((a, b) => a.k - b.k || (a.abbr < b.abbr ? -1 : 1))
    .map((x) => x.abbr);

  const games = [];
  for (let i = 0; i + 1 < rotated.length; i += 2) {
    // Alternate which side is home across the season so no team is always home.
    const flip = (week + i) % 2 === 0;
    games.push(flip ? [rotated[i], rotated[i + 1]] : [rotated[i + 1], rotated[i]]);
  }
  return games;   // [home, away]
}

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** Thursday, three Sunday windows, then Monday — the real weekly rhythm. */
function kickoffFor(week, index, total) {
  const thursday = WEEK1_THURSDAY + (week - 1) * 7 * 86400000;
  if (index === 0) return iso(thursday + 20.25 * 3600000);            // Thu 20:15 ET
  if (index === total - 1) return iso(thursday + 4 * 86400000 + 20.25 * 3600000); // Mon
  const sunday = thursday + 3 * 86400000;
  if (index <= total - 4) return iso(sunday + 17 * 3600000);          // 13:00 ET
  if (index === total - 3) return iso(sunday + 20.42 * 3600000);      // 16:25 ET
  return iso(sunday + 24.33 * 3600000);                               // 20:20 ET
}

/** A spread, rounded to the half point the way a book actually posts it. */
function spreadFor(home, away) {
  const edge = (RATINGS.get(home) - RATINGS.get(away)) + HOME_FIELD;
  const rounded = Math.round(edge * 2) / 2;
  return -rounded;   // ESPN signs the spread relative to the home team
}

/**
 * American moneylines for a home win probability, carrying a book's margin.
 *
 * Both sides are inflated by the same overround, which is what makes this a
 * useful fixture rather than decoration: de-vigging the pair recovers exactly
 * the probability that went in, so a fixture game priced this way is
 * internally consistent with its own spread.
 *
 * They used to be a flat `-200 / +170` for every game regardless of the line.
 * That was harmless while nothing read them, and became a real problem the
 * moment the engine did: every moneyline-priced favourite resolved to the
 * identical 64.3%, so a board of them carried no ranking signal at all.
 */
const OVERROUND = 1.045;

function americanFor(prob) {
  const priced = Math.max(0.01, Math.min(0.99, prob * OVERROUND));
  return priced >= 0.5
    ? -Math.round((priced / (1 - priced)) * 100)
    : Math.round(((1 - priced) / priced) * 100);
}

/** A logistic on the spread — the usual shape, and only ever a fixture value. */
function homeWinPct(spread) {
  const favouredBy = -spread;
  const p = 1 / (1 + Math.exp(-favouredBy / 4.2));
  return Math.round(p * 1000) / 1000;
}

const eventId = (week, i) => `4017${String(week).padStart(2, '0')}${String(i).padStart(2, '0')}`;

/**
 * A synthetic nfelo table for this synthetic season.
 *
 * The whole point of the divergence display is what happens when two models
 * *disagree*, so a fixture where the Elo probability equals the market's would
 * exercise the code and show nothing.
 *
 * But the disagreement has to be the *size* a real disagreement is, and the
 * first version of this got that wrong in a way only a screenshot caught: an
 * independent second draw of every team's rating produced divergences of
 * sixteen points, which is not a model disagreeing with the market, it is a
 * different sport. The photograph looked like a bug.
 *
 * So it is a perturbation: each team's Elo rating is its market rating plus a
 * seeded wobble of a couple of points. That puts most games within about three
 * points of the line and a handful further out, which is what nfelo against a
 * closing line actually looks like — and it is still more than enough to
 * exercise every branch of the blend and the divergence display.
 *
 * Two absences are deliberate and both are the ordinary case in the real file:
 * nfelo has not rated week 18 at all, and it is missing scattered games
 * elsewhere. Every one of those has to fall back to the market silently. A
 * fixture where every game is rated would never exercise the path that runs on
 * most Sundays in September.
 */
const eloRate = rng(20260911);
const ELO_RATINGS = new Map(TEAMS.map((t) => [
  t.abbr, Math.round((RATINGS.get(t.abbr) + (eloRate() * 3 - 1.5)) * 10) / 10,
]));

function nfeloTable() {
  const skip = rng(4242);
  const table = {};
  for (let week = 1; week <= WEEKS; week += 1) {
    if (week === WEEKS) continue;                    // nfelo has not got here yet
    for (const [home, away] of matchupsFor(week)) {
      if (skip() < 0.08) continue;                   // an unrated game, scattered
      const edge = (ELO_RATINGS.get(home) - ELO_RATINGS.get(away)) + HOME_FIELD;
      const p = 1 / (1 + Math.exp(-edge / 4.2));
      const id = `${SEASON}_${String(week).padStart(2, '0')}_${away}_${home}`;
      table[id] = Math.round(Math.max(0.02, Math.min(0.98, p)) * 10000) / 10000;
    }
  }
  return table;
}

function competitor(abbr, homeAway) {
  const t = TEAMS.find((x) => x.abbr === abbr);
  return {
    homeAway,
    score: null,
    winner: null,
    records: [{ summary: '0-0' }],
    team: { id: String(TEAMS.indexOf(t) + 1), abbreviation: t.abbr, displayName: t.name, shortDisplayName: t.short },
  };
}

/**
 * One week, in ESPN's shape.
 *
 * `omitProbability`, `omitMoneylines` and `omitOdds` take game indices, and
 * between them build every rung of the source ladder: a game ESPN has priced
 * and modelled uses the published figure; one modelled by nobody but priced
 * with both moneylines falls to the de-vigged market; one carrying only a
 * spread falls to the estimate; one with no odds at all has to sort last
 * rather than being dropped.
 *
 * `omitMoneylines` exists because without it the estimate is unreachable.
 * Every fixture game carries odds, and odds now carry moneylines, so once the
 * engine learned to read them there was no path left to the spread — the
 * fallback and the amber treatment that goes with it were covered by nothing.
 */
function makeWeek(week, {
  states = {},
  omitProbability = new Set(),
  omitOdds = new Set(),
  omitMoneylines = new Set(),
  only = null,
  forceSpread = null,
  forceHomeWinPct = null,
} = {}) {
  let pairs = matchupsFor(week);
  if (only !== null) pairs = pairs.slice(0, only);

  const events = [];
  const probabilities = {};
  const odds = {};

  pairs.forEach(([home, away], i) => {
    const id = eventId(week, i);
    const spread = forceSpread ? forceSpread(i, home, away) : spreadFor(home, away);
    const hp = forceHomeWinPct ? forceHomeWinPct(i) : homeWinPct(spread);

    events.push({
      id,
      uid: `s:20~l:28~e:${id}`,
      date: kickoffFor(week, i, pairs.length),
      name: `${TEAMS.find((t) => t.abbr === away).name} at ${TEAMS.find((t) => t.abbr === home).name}`,
      shortName: `${away} @ ${home}`,
      status: { type: { state: states[i] ?? 'pre', completed: (states[i] ?? 'pre') === 'post' } },
      competitions: [{ id, competitors: [competitor(home, 'home'), competitor(away, 'away')] }],
    });

    if (!omitProbability.has(i)) {
      // ESPN publishes a tie percentage and the ported strategies do not read
      // it. It is in the fixture anyway, so the gap stays visible in the data.
      const tie = 0.004;
      probabilities[id] = { items: [{ playId: null, homeWinPercentage: hp, awayWinPercentage: Math.round((1 - hp - tie) * 1000) / 1000, tiePercentage: tie }] };
    }
    if (!omitOdds.has(i)) {
      const favAbbr = spread <= 0 ? home : away;
      const line = Math.abs(spread);
      odds[id] = {
        items: [{
          provider: { name: 'ESPN BET', priority: 1 },
          details: line === 0 ? 'EVEN' : `${favAbbr} -${line}`,
          spread,
          overUnder: 44.5,
          homeTeamOdds: { favorite: spread <= 0, moneyLine: omitMoneylines.has(i) ? null : americanFor(hp), team: { abbreviation: home } },
          awayTeamOdds: { favorite: spread > 0, moneyLine: omitMoneylines.has(i) ? null : americanFor(1 - hp), team: { abbreviation: away } },
        }],
      };
    }
  });

  return {
    scoreboard: { week: { number: week }, season: { year: SEASON, type: SEASON_TYPE }, events },
    probabilities,
    odds,
  };
}

/* ------------------------------------------------------------ the output -- */

mkdirSync(OUT, { recursive: true });
const written = [];

function write(name, meta, payload) {
  const body = { meta: { name, generatedBy: 'scripts/make-fixtures.mjs', season: SEASON, seasonType: SEASON_TYPE, ...meta }, ...payload };
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
  written.push(name);
}

// The season. Every week priced and modelled — this is what a healthy
// Wednesday looks like, and it is what gives the lookahead a real schedule.
const weeks = {};
for (let w = 1; w <= WEEKS; w += 1) weeks[w] = makeWeek(w);
write('season-2026', {
  note: 'A full synthetic 18-week season, every game priced and modelled. The schedule that makes future-value non-trivial.',
  weeks: WEEKS,
  byes: Object.fromEntries(BYES),
}, { weeks });

// The second opinion, for the same synthetic season. Not a week bundle — it
// is the shape /api/nfelo answers with — so it is written straight rather than
// through `write`, which stamps a week fixture's meta.
writeFileSync(join(OUT, 'nfelo-2026.json'), `${JSON.stringify({
  meta: {
    name: 'nfelo-2026',
    generatedBy: 'scripts/make-fixtures.mjs',
    season: SEASON,
    note: 'A synthetic nfelo table for season-2026: a second seeded rating per team, '
      + 'so the two models genuinely disagree. Week 18 and about 8% of other games are '
      + 'deliberately unrated, which is the ordinary case in the real file.',
  },
  ok: true,
  season: SEASON,
  upstream: 'nfelo',
  probabilities: nfeloTable(),
}, null, 2)}\n`);
written.push('nfelo-2026');

// Every rung of the source ladder in one week. ESPN has not modelled 2, 5, 9
// or 12; of those, 5 and 12 also have no moneylines and so fall all the way to
// the spread estimate, while 2 and 9 are carried by the de-vigged market. 7 has
// no odds at all and must sort last rather than vanish.
write('case-mixed-sources', {
  note: 'Every source in one week: ESPN\'s own figure, the de-vigged moneyline, the spread estimate, and one game with nothing at all. Exercises the whole fallback ladder and the no-data sort.',
  week: 3,
}, makeWeek(3, {
  omitProbability: new Set([2, 5, 7, 9, 12]),
  omitMoneylines: new Set([5, 12]),
  omitOdds: new Set([7]),
}));

// Sunday afternoon: the early window has kicked off and the board has shrunk.
write('case-started-games', {
  note: 'Six games already in progress or final. Every strategy must exclude them, and the interface has to be able to say why.',
  week: 4,
}, makeWeek(4, { states: { 0: 'post', 1: 'in', 2: 'in', 3: 'post', 4: 'in', 5: 'in' } }));

// Three close games and nothing safe. The floor cannot be met, so it has to be
// relaxed out loud rather than leaving an entry without a pick.
write('case-thin-board', {
  note: 'Three near-even games. Nothing clears the 65% floor, so the relaxation path and its reasoning are exercised.',
  week: 9,
}, makeWeek(9, { only: 3, forceSpread: (i) => [-1.0, 0.5, -1.5][i] }));

// Several games priced identically, so many pairs share an objective to three
// decimal places and the (-objective, teamA, teamB) tie-break decides.
write('case-tied-objectives', {
  note: 'Repeated identical lines, so the joint optimizer has genuine ties and its abbreviation tie-break is what picks the answer.',
  week: 6,
}, makeWeek(6, { forceSpread: (i) => [-7.0, -7.0, -7.0, -3.5, -3.5, -7.0, -3.5][i % 7] }));

// Probabilities chosen to land exactly on a half at one decimal place, which
// is where Python's round-half-to-even and JavaScript's toFixed disagree:
// 0.8625 scales to 86.25, which Python prints as 86.2 and toFixed as 86.3.
//
// This fixture exists because the parity suite did not catch that. Replacing
// fmt.js's half-even rounding with a plain toFixed left all nine runs green —
// the same "the test passes and the code is dead" shape the audit found in the
// Python. A guard nothing exercises is not a guard.
const HALF_BOUNDARIES = [0.8625, 0.7425, 0.9225, 0.6525, 0.8125, 0.5525, 0.7825, 0.9425,
                         0.6825, 0.8925, 0.7125, 0.6025, 0.8425, 0.5725, 0.9025, 0.7625];
write('case-rounding-edges', {
  note: 'Every probability sits exactly on a rounding boundary at one decimal place, where Python rounds to even and JavaScript\'s toFixed rounds away from zero. The one fixture that proves fmt.js is load-bearing.',
  week: 2,
}, makeWeek(2, { forceHomeWinPct: (i) => HALF_BOUNDARIES[i % HALF_BOUNDARIES.length] }));

console.log(`fixtures → fixtures/weeks/`);
for (const n of written) console.log(`  ${n}.json`);
