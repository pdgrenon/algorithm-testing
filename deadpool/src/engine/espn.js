/**
 * ESPN's undocumented responses → the Game shape the engine reasons about.
 *
 * A direct port of the parsing half of `survivor-picker/data/espn_client.py`,
 * and it lives in exactly one place on purpose. The edge Function imports it
 * to normalise before answering, so the browser never ships a parser for
 * somebody else's unsupported API, and when a field gets renamed there is one
 * line to change rather than one per surface.
 *
 * Every field is optional, because ESPN does not publish or support these
 * endpoints and a missing key is a Tuesday rather than an outage. `safeGet` is
 * why: it degrades to null rather than throwing, so one malformed game cannot
 * take the whole week down with it.
 */

/** Walk a nested structure along `path`, returning `fallback` on any miss. */
export function safeGet(obj, path, fallback = null) {
  let cur = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return fallback;
    try {
      cur = cur[key];
    } catch {
      return fallback;
    }
  }
  return cur === null || cur === undefined ? fallback : cur;
}

const toInt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const emptyTeam = () => ({
  id: null, abbreviation: null, displayName: null, shortName: null,
  score: null, winner: null, record: null,
});

function parseTeam(competitor) {
  const t = safeGet(competitor, ['team'], {});
  return {
    id: safeGet(t, ['id']),
    abbreviation: safeGet(t, ['abbreviation']),
    displayName: safeGet(t, ['displayName']),
    shortName: safeGet(t, ['shortDisplayName']),
    score: toInt(safeGet(competitor, ['score'])),
    winner: safeGet(competitor, ['winner']),
    record: safeGet(competitor, ['records', 0, 'summary']),
  };
}

/** The scoreboard payload → games, with no probability or odds attached yet. */
export function parseGames(scoreboard) {
  const events = safeGet(scoreboard, ['events'], []) || [];
  const week = safeGet(scoreboard, ['week', 'number']);
  const seasonYear = safeGet(scoreboard, ['season', 'year']);
  const seasonType = safeGet(scoreboard, ['season', 'type']);

  return events.map((event) => {
    const competitions = safeGet(event, ['competitions'], []) || [];
    const competition = competitions[0] ?? {};
    const competitors = safeGet(competition, ['competitors'], []) || [];

    const homeRaw = competitors.find((c) => safeGet(c, ['homeAway']) === 'home');
    const awayRaw = competitors.find((c) => safeGet(c, ['homeAway']) === 'away');

    return {
      eventId: safeGet(event, ['id']),
      competitionId: safeGet(competition, ['id']) ?? safeGet(event, ['id']),
      week: toInt(week),
      seasonYear: toInt(seasonYear),
      seasonType: toInt(seasonType),
      startDate: safeGet(event, ['date']),
      // "pre" | "in" | "post". Everything downstream treats anything other
      // than "pre" as no longer pickable, so a null is deliberately left null
      // rather than defaulted — an unknown state is not a started game.
      state: safeGet(event, ['status', 'type', 'state']),
      home: homeRaw ? parseTeam(homeRaw) : emptyTeam(),
      away: awayRaw ? parseTeam(awayRaw) : emptyTeam(),
      probability: null,
      odds: null,
    };
  });
}

/**
 * The probabilities payload → one pregame win-probability pair.
 *
 * items[0] is the pregame estimate; ESPN appends one item per play as the game
 * progresses, so the first entry stays the pre-kickoff number for the whole
 * game rather than drifting with the score.
 */
export function parseProbability(json) {
  if (!json) return null;
  const items = safeGet(json, ['items'], []) || [];
  if (!items.length) return null;
  const first = items[0];
  return {
    homeWinPct: toNum(safeGet(first, ['homeWinPercentage'])),
    awayWinPct: toNum(safeGet(first, ['awayWinPercentage'])),
    // Parsed and, for now, deliberately unread by the ported strategies —
    // they were written without it. It is carried through so a future
    // strategy can weigh a tie without a second fetch, and so the gap lives
    // in the data rather than only in a note somewhere.
    tiePct: toNum(safeGet(first, ['tiePercentage'])),
    isPregame: [null, 0].includes(safeGet(first, ['playId'])),
  };
}

/** The odds payload → the first provider's line. */
export function parseOdds(json) {
  if (!json) return null;
  const items = safeGet(json, ['items'], []) || [];
  if (!items.length) return null;
  const first = items[0];

  const moneyline = (side) => toInt(safeGet(first, [`${side}TeamOdds`, 'moneyLine']));

  let favorite = null;
  if (safeGet(first, ['homeTeamOdds', 'favorite'])) favorite = safeGet(first, ['homeTeamOdds', 'team', 'abbreviation']);
  else if (safeGet(first, ['awayTeamOdds', 'favorite'])) favorite = safeGet(first, ['awayTeamOdds', 'team', 'abbreviation']);

  return {
    provider: safeGet(first, ['provider', 'name']),
    details: safeGet(first, ['details']),
    // Signed relative to the HOME team: negative means home is favoured.
    // win-prob.js flips it, and getting that backwards recommends every
    // underdog in the league without erroring once.
    spread: toNum(safeGet(first, ['spread'])),
    overUnder: toNum(safeGet(first, ['overUnder'])),
    homeMoneyline: moneyline('home'),
    awayMoneyline: moneyline('away'),
    favoriteAbbreviation: favorite,
  };
}

/**
 * The odds ESPN already put inside the scoreboard, when they are there.
 *
 * Not in the Python, which always spends a separate request per game. The
 * scoreboard commonly carries the same provider objects inline under
 * `competitions[0].odds`, in the same shape as the odds endpoint's `items`,
 * and reading them here is what takes a week from thirty-three requests down
 * to a handful. It is a fetching change, not a parsing one: the same
 * parseOdds runs on the same object either way.
 *
 * Returns null when they are absent, so the caller knows to go and ask.
 */
export function parseInlineOdds(scoreboardEvent) {
  const inline = safeGet(scoreboardEvent, ['competitions', 0, 'odds']);
  if (!Array.isArray(inline) || !inline.length) return null;
  return parseOdds({ items: inline });
}

/** Attach probability and odds payloads to a parsed game, in place. */
export function enrich(game, probabilityJson, oddsJson) {
  game.probability = parseProbability(probabilityJson);
  game.odds = parseOdds(oddsJson);
  return game;
}
