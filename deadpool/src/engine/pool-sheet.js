/**
 * Read the pool's own pick sheet, which is the only real data about the field.
 *
 * A port of data/pool_sheet.py, and held to it: the Python is the definition
 * and test/pool-sheet.test.js mirrors tests/test_pool_sheet.py case for case.
 * Everything the engine believes about opponents is otherwise a prior.
 *
 * ── The shape it arrives in, which is an assumption ─────────────────────
 *
 * One row per entry, one column per week, exported to CSV:
 *
 *     Team Name        , Elimination Status , Week 1 Pick , Week 2 Pick , ...
 *     Gridiron Gang    , Alive              , KC          , Bills       , ...
 *     Ship of Theseus  , Out - Week 3       , Chiefs      , SF          , ...
 *
 * Nobody has seen the real sheet yet. That layout is a guess, the headings
 * recognised below are a guess at how it will be labelled, and the sharing
 * mode the fetcher assumes is a third guess. All three are written down in
 * functions/api/pool.js so they can be corrected in one pass when the real
 * export arrives rather than discovered one failure at a time.
 *
 * **"Team Name" is the entry's name, not an NFL team.** Reading it as a team
 * would silently produce a field of 250 nonexistent franchises.
 *
 * **A column is added each week**, so nothing hardcodes eighteen.
 *
 * ── Names are the hard part, and a wrong one is silent ──────────────────
 *
 * A name that fails to resolve is loud and fixable. A name that resolves to
 * the *wrong* team is not: it puts an opponent on a team they never picked,
 * which corrupts their inventory and every forecast built on it, and nothing
 * about the output looks wrong. So ambiguity is refused rather than guessed --
 * "LA" has been two teams since 2017, and "NY" always was.
 */

/** Full names and cities, keyed by the abbreviation this codebase uses. */
const TEAM_NAMES = {
  "ARI": ["Arizona", "Cardinals", "Arizona Cardinals"],
  "ATL": ["Atlanta", "Falcons", "Atlanta Falcons"],
  "BAL": ["Baltimore", "Ravens", "Baltimore Ravens"],
  "BUF": ["Buffalo", "Bills", "Buffalo Bills"],
  "CAR": ["Carolina", "Panthers", "Carolina Panthers"],
  "CHI": ["Chicago", "Bears", "Chicago Bears"],
  "CIN": ["Cincinnati", "Bengals", "Cincinnati Bengals"],
  "CLE": ["Cleveland", "Browns", "Cleveland Browns"],
  "DAL": ["Dallas", "Cowboys", "Dallas Cowboys"],
  "DEN": ["Denver", "Broncos", "Denver Broncos"],
  "DET": ["Detroit", "Lions", "Detroit Lions"],
  "GB": ["Green Bay", "Packers", "Green Bay Packers"],
  "HOU": ["Houston", "Texans", "Houston Texans"],
  "IND": ["Indianapolis", "Colts", "Indianapolis Colts"],
  "JAX": ["Jacksonville", "Jaguars", "Jacksonville Jaguars"],
  "KC": ["Kansas City", "Chiefs", "Kansas City Chiefs"],
  "LAC": ["Los Angeles Chargers", "Chargers", "Los Angeles Chargers"],
  "LAR": ["Los Angeles Rams", "Rams", "Los Angeles Rams"],
  "LV": ["Las Vegas", "Raiders", "Las Vegas Raiders"],
  "MIA": ["Miami", "Dolphins", "Miami Dolphins"],
  "MIN": ["Minnesota", "Vikings", "Minnesota Vikings"],
  "NE": ["New England", "Patriots", "New England Patriots"],
  "NO": ["New Orleans", "Saints", "New Orleans Saints"],
  "NYG": ["New York Giants", "Giants", "New York Giants"],
  "NYJ": ["New York Jets", "Jets", "New York Jets"],
  "PHI": ["Philadelphia", "Eagles", "Philadelphia Eagles"],
  "PIT": ["Pittsburgh", "Steelers", "Pittsburgh Steelers"],
  "SEA": ["Seattle", "Seahawks", "Seattle Seahawks"],
  "SF": ["San Francisco", "49ers", "San Francisco 49ers"],
  "TB": ["Tampa Bay", "Buccaneers", "Tampa Bay Buccaneers"],
  "TEN": ["Tennessee", "Titans", "Tennessee Titans"],
  "WSH": ["Washington", "Commanders", "Washington Commanders"],
};

/** Alternates a person might reasonably type, including moved franchises. */
const EXTRA_ALIASES = {
  "9ers": "SF",
  "bucs": "TB",
  "cards": "ARI",
  "football team": "WSH",
  "g-men": "NYG",
  "gnb": "GB",
  "green bay packers": "GB",
  "jac": "JAX",
  "jags": "JAX",
  "jaguars": "JAX",
  "kan": "KC",
  "la chargers": "LAC",
  "la rams": "LAR",
  "lvr": "LV",
  "ne patriots": "NE",
  "niners": "SF",
  "nor": "NO",
  "nwe": "NE",
  "ny giants": "NYG",
  "ny jets": "NYJ",
  "oak": "LV",
  "oakland": "LV",
  "pats": "NE",
  "raiders": "LV",
  "redskins": "WSH",
  "san diego": "LAC",
  "sd": "LAC",
  "sdg": "LAC",
  "sfo": "SF",
  "st louis": "LAR",
  "st. louis": "LAR",
  "stl": "LAR",
  "tam": "TB",
  "was": "WSH",
  "wash": "WSH",
};

/** Strings naming more than one team, refused rather than guessed. */
export const AMBIGUOUS = {
  "la": ["LAR", "LAC"],
  "los angeles": ["LAR", "LAC"],
  "new york": ["NYG", "NYJ"],
  "ny": ["NYG", "NYJ"],
};

export class UnknownTeam extends Error {}
export class AmbiguousTeam extends Error {}

/** Lowercase, strip punctuation, collapse whitespace. */
function key(value) {
  return (value || '')
    .replace(/[^\w\s]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const LOOKUP = (() => {
  const out = new Map();
  for (const [abbr, [city, nickname, full]] of Object.entries(TEAM_NAMES)) {
    for (const form of [abbr, city, nickname, full]) out.set(key(form), abbr);
  }
  for (const [alias, abbr] of Object.entries(EXTRA_ALIASES)) out.set(key(alias), abbr);
  // Never let an alias shadow an ambiguous string.
  for (const word of Object.keys(AMBIGUOUS)) out.delete(key(word));
  return out;
})();

// Headings that identify each column, matched on the normalised key so
// "Elimination Status", "elimination_status" and "Status" all land.
const ENTRY_HEADINGS = ['team name', 'team', 'entry', 'entry name', 'name', 'player', 'owner'];
const STATUS_HEADINGS = ['elimination status', 'status', 'eliminated', 'alive', 'state'];
const WEEK_PATTERN = /^(?:week|wk|w)?\s*[_-]?\s*(\d{1,2})\s*(?:pick|picks)?$/;

// Text meaning "still in". Everything else reads as out, because a sheet says
// "Out - Week 5" in more ways than it says "Alive", and treating an
// unrecognised status as alive is the direction that inflates the field.
const ALIVE_WORDS = new Set(['alive', 'in', 'active', 'live', 'yes', 'y', 'still in', 'surviving', '']);

/**
 * A written team name to this codebase's abbreviation.
 *
 * Null for a blank cell, which is an entry that has not picked that week
 * rather than an error. Throws on anything that does not resolve, and on
 * anything that resolves to more than one team.
 */
export function normalizeTeam(raw) {
  const k = key(raw);
  if (!k) return null;
  if (k in AMBIGUOUS) {
    throw new AmbiguousTeam(
      `${JSON.stringify(raw)} could be ${AMBIGUOUS[k].join(' or ')} -- refusing to guess. Write the full name.`,
    );
  }
  const abbr = LOOKUP.get(k);
  if (abbr === undefined) {
    throw new UnknownTeam(`${JSON.stringify(raw)} is not a team this reader knows.`);
  }
  return abbr;
}

/**
 * Minimal RFC 4180 CSV reader.
 *
 * Written out rather than pulled in, because `dependencies` is empty and stays
 * that way. Handles quoted fields, embedded commas and newlines, and doubled
 * quotes -- an entry called `O'Brien, "The Streak"` is a real thing a person
 * types into a pool sheet.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = (text || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** (entry column, status column, {week: column}) from the header row. */
function classifyHeaders(headers) {
  let entryCol = null;
  let statusCol = null;
  const weekCols = new Map();

  headers.forEach((raw, i) => {
    const k = key(raw);
    if (!k) return;
    const match = WEEK_PATTERN.exec(k);
    if (match) { weekCols.set(Number(match[1]), i); return; }
    if (statusCol === null && STATUS_HEADINGS.includes(k)) { statusCol = i; return; }
    if (entryCol === null && ENTRY_HEADINGS.includes(k)) entryCol = i;
  });

  // A sheet whose first column is unlabelled is still readable: the entry name
  // is whatever is left of the first week column.
  if (entryCol === null && weekCols.size) {
    const firstWeek = Math.min(...weekCols.values());
    if (firstWeek > 0) entryCol = 0;
  }
  return { entryCol, statusCol, weekCols };
}

/**
 * Read a pool pick sheet from CSV text.
 *
 * Unresolvable cells are collected into `problems` and skipped rather than
 * thrown, so one typo in row 180 does not cost the other 249 rows. `strict`
 * throws on the first one instead, which is what a test wants.
 */
export function loadPoolSheet(text, { strict = false } = {}) {
  const rows = parseCsv(text);
  if (!rows.length) return { entries: [], weeks: [], problems: ['the sheet is empty'] };

  const { entryCol, statusCol, weekCols } = classifyHeaders(rows[0]);
  const weeks = [...weekCols.keys()].sort((a, b) => a - b);
  const sheet = { entries: [], weeks, problems: [] };

  if (entryCol === null) {
    sheet.problems.push("no entry-name column found; expected a heading like 'Team Name' or 'Entry'");
    return sheet;
  }
  if (!weekCols.size) {
    sheet.problems.push("no week columns found; expected headings like 'Week 1 Pick'");
    return sheet;
  }

  rows.slice(1).forEach((row, idx) => {
    const line = idx + 2;
    if (!row.some((cell) => cell.trim())) return;
    const name = entryCol < row.length ? row[entryCol].trim() : '';
    if (!name) { sheet.problems.push(`row ${line}: no entry name; skipped`); return; }

    const status = statusCol !== null && statusCol < row.length ? row[statusCol].trim() : '';
    const entry = { entryName: name, picks: {}, statusText: status, alive: ALIVE_WORDS.has(key(status)) };

    for (const week of weeks) {
      const col = weekCols.get(week);
      const cell = col < row.length ? row[col] : '';
      let team;
      try {
        team = normalizeTeam(cell);
      } catch (err) {
        if (strict) throw err;
        sheet.problems.push(`row ${line} (${name}), week ${week}: ${err.message}`);
        continue;
      }
      if (team !== null) entry.picks[week] = team;
    }
    sheet.entries.push(entry);
  });

  sheet.problems.push(...consistencyProblems(sheet));
  return sheet;
}

/**
 * Things that are readable but cannot be true.
 *
 * Not parse failures -- every cell resolved. The sheet disagreeing with
 * itself, which is worth surfacing because the engine is about to treat it as
 * ground truth about 250 people.
 */
function consistencyProblems(sheet) {
  const problems = [];
  for (const entry of sheet.entries) {
    const seen = new Map();
    for (const week of Object.keys(entry.picks).map(Number).sort((a, b) => a - b)) {
      const team = entry.picks[week];
      if (seen.has(team)) {
        problems.push(
          `${entry.entryName}: picked ${team} in both week ${seen.get(team)} and week ${week} -- a team can only be spent once`,
        );
      } else seen.set(team, week);
    }
    const picked = Object.keys(entry.picks).map(Number);
    if (entry.alive && picked.length) {
      const last = Math.max(...picked);
      const missing = sheet.weeks.filter((w) => w <= last && !(w in entry.picks));
      if (missing.length) {
        problems.push(
          `${entry.entryName}: alive, but no pick recorded for week${missing.length > 1 ? 's' : ''} [${missing.join(', ')}]`,
        );
      }
    }
  }
  return problems;
}

/** Every team an entry has spent -- the thing the engine actually needs. */
export function usedTeams(entry) {
  return new Set(Object.values(entry.picks));
}

/** The inventory table, exact rather than estimated. */
export function usedTeamsByEntry(sheet) {
  const out = {};
  for (const entry of sheet.entries) out[entry.entryName] = usedTeams(entry);
  return out;
}

/** Entries still in. */
export function aliveEntries(sheet) {
  return sheet.entries.filter((e) => e.alive);
}

/**
 * What share of the field took each team in `week`.
 *
 * Observed, not modelled -- the number the popularity prior is supposed to
 * predict, and having it is what makes fitting that prior against *this* pool
 * possible rather than borrowing a national average.
 */
export function popularity(sheet, week) {
  const picks = sheet.entries.filter((e) => week in e.picks).map((e) => e.picks[week]);
  if (!picks.length) return {};
  const out = {};
  for (const team of [...new Set(picks)].sort()) {
    out[team] = picks.filter((t) => t === team).length / picks.length;
  }
  return out;
}
