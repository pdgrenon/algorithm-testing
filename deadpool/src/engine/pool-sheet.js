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
 * That layout was written before anyone had seen the real sheet, and the
 * headings below are still a range rather than one name, so a sheet labelled
 * differently keeps working. The real export is described in the next section.
 *
 * **"Team Name" is the entry's name, not an NFL team.** Reading it as a team
 * would silently produce a field of 250 nonexistent franchises.
 *
 * **A column is added each week**, so nothing hardcodes eighteen.
 *
 * ── The sheet this pool actually keeps ──────────────────────────────────
 *
 * Checked against a full export of the 2026 tab in week 3. It differs from
 * the guess above in three ways, all handled here (data/pool_sheet.py has the
 * worked example):
 *
 *   * a title row ("2026") sits above the header, so the header is the first
 *     row with an entry heading and a week column;
 *   * the entries end at the first blank row, and below it is the
 *     commissioner's per-team tally, whose first column is NFL team names --
 *     anything down there that reads as a pick is reported, not dropped;
 *   * there is no status column. `NONE` in a pick cell means the entry lost
 *     earlier, `Missing` means it did not pick; either marks it out and spends
 *     no team. That is a week behind by construction: an entry that lost on
 *     Sunday reads alive until the next column is filled in.
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

/**
 * Lowercase, strip punctuation, collapse whitespace.
 *
 * The underscore is folded to a space rather than stripped, and that is not
 * cosmetic. `\w` *includes* `_`, so `[^\w\s]` leaves it alone and
 * `elimination_status` normalised to itself — which is in none of the heading
 * lists, though the comment beside them says it lands. A sheet exported with
 * underscored headings therefore had no status column at all, and since the
 * empty string reads as alive, every entry in it came back alive.
 */
function key(value) {
  return (value || '')
    .replace(/_/g, ' ')
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

// Pick-cell text meaning "this entry is out", not a team. `NONE` fills every
// week after the one an entry lost; `Missing` is a week it did not pick, which
// this pool counts as an elimination. Matched on the normalised key.
const OUT_MARKERS = new Set(['none', 'missing']);

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
 * Index of the header row: the first with an entry heading and a week column.
 *
 * A title row above it ("2026") has neither. Falls back to the first row, which
 * keeps a sheet whose entry column is unlabelled readable as before. It needs an
 * entry *heading*, not just a week-shaped cell, because the tally rows under
 * the entries are full of small numbers that match the week pattern.
 */
function findHeader(rows) {
  const i = rows.findIndex((row) => {
    const keys = row.map(key);
    return keys.some((k) => ENTRY_HEADINGS.includes(k)) && keys.some((k) => k && WEEK_PATTERN.test(k));
  });
  return i === -1 ? 0 : i;
}

const isBlank = (row) => !row.some((cell) => cell.trim());

/** A team or an out-marker: something only an entry row would hold. */
function readsAsPick(cell) {
  if (OUT_MARKERS.has(key(cell))) return true;
  try {
    return normalizeTeam(cell) !== null;
  } catch {
    return false;
  }
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

  const header = findHeader(rows);
  const { entryCol, statusCol, weekCols } = classifyHeaders(rows[header]);
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

  let body = rows.slice(header + 1);
  // Leading blank rows are not the end of anything; the first blank row after
  // an entry is.
  while (body.length && isBlank(body[0])) body = body.slice(1);
  const first = rows.length - body.length + 1;
  let end = body.findIndex(isBlank);
  if (end === -1) end = body.length;

  body.slice(0, end).forEach((row, idx) => {
    const line = idx + first;
    const name = entryCol < row.length ? row[entryCol].trim() : '';
    if (!name) { sheet.problems.push(`row ${line}: no entry name; skipped`); return; }

    const status = statusCol !== null && statusCol < row.length ? row[statusCol].trim() : '';
    const entry = {
      entryName: name, picks: {}, statusText: status, alive: ALIVE_WORDS.has(key(status)), outMarks: {},
    };

    for (const week of weeks) {
      const col = weekCols.get(week);
      const cell = col < row.length ? row[col] : '';
      if (OUT_MARKERS.has(key(cell))) {
        entry.alive = false;
        entry.outMarks[week] = cell.trim();
        continue;
      }
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

  // Below the first blank row is the commissioner's tally, which is not read.
  // An entry that ended up down there would be lost without a word, so say so
  // if anything below the gap reads as a pick.
  body.slice(end).forEach((row, idx) => {
    if ([...weekCols.values()].some((col) => col < row.length && readsAsPick(row[col]))) {
      sheet.problems.push(
        `row ${first + end + idx}: looks like an entry, but sits below the blank row that `
        + `ends the entries at row ${first + end}; not read`,
      );
    }
  });

  const marked = sheet.entries.some((e) => Object.keys(e.outMarks).length);

  // A sheet with no status column is not a sheet where everybody is alive.
  //
  // `ALIVE_WORDS` contains the empty string, which is right for a blank cell
  // in a sheet that has the column — a survivor's row is usually left empty.
  // With no column at all every row reads blank, so a 250-entry sheet comes
  // back as 250 survivors with `problems: []`, and the Pool screen prints that
  // as fact. Whether the field is 250 or 12 is most of what the screen is for.
  if (statusCol === null && !marked) {
    sheet.problems.push(
      "no elimination-status column found; expected a heading like 'Elimination Status' or 'Status'."
      + ' Every entry is being counted as still alive, which is almost certainly wrong.',
    );
  } else if (statusCol !== null && sheet.entries.length && !sheet.entries.some((e) => e.alive)) {
    // The opposite failure, and just as quiet: a column whose vocabulary this
    // does not know reads as eliminated on every row, because an unrecognised
    // status deliberately means out.
    const seen = [...new Set(sheet.entries.map((e) => e.statusText).filter(Boolean))].slice(0, 3);
    sheet.problems.push(
      `the status column resolved every entry as eliminated${seen.length ? ` (saw ${seen.map((s) => `"${s}"`).join(', ')})` : ''}.`
      + ' An unrecognised status reads as out, so check the column is the one intended.',
    );
  }

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
    const marks = Object.keys(entry.outMarks).map(Number);
    if (marks.length) {
      const outFrom = Math.min(...marks);
      const later = Object.keys(entry.picks).map(Number).filter((w) => w > outFrom).sort((a, b) => a - b);
      if (later.length) {
        problems.push(
          `${entry.entryName}: marked ${JSON.stringify(entry.outMarks[outFrom])} in week ${outFrom} `
          + `but has a pick in week${later.length > 1 ? 's' : ''} [${later.join(', ')}]`
          + ' -- an entry that is out cannot pick',
        );
      }
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
