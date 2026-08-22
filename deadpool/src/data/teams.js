/**
 * The 32 NFL teams, by the abbreviation ESPN uses.
 *
 * The abbreviation is the join key for everything in this app — a pick, a
 * used-teams list, a board cell — so it has to be ESPN's and not the more
 * familiar one. Four of them differ from what most people would write: WSH
 * rather than WAS, LAR rather than LA, LV rather than LVR, and JAX rather
 * than JAC. Getting one wrong does not throw; it produces a board cell that
 * never lights up and a pick that can be made twice.
 *
 * Deliberately no team colours. The board is coloured by *state* — burned,
 * available, playing this week, on bye — because that is the question being
 * asked of it, and thirty-two brand palettes would drown the four answers
 * that matter in a field of navy and red.
 */

export const TEAMS = [
  { abbr: 'ARI', name: 'Arizona Cardinals',      short: 'Cardinals',  conf: 'NFC', div: 'West' },
  { abbr: 'ATL', name: 'Atlanta Falcons',        short: 'Falcons',    conf: 'NFC', div: 'South' },
  { abbr: 'BAL', name: 'Baltimore Ravens',       short: 'Ravens',     conf: 'AFC', div: 'North' },
  { abbr: 'BUF', name: 'Buffalo Bills',          short: 'Bills',      conf: 'AFC', div: 'East' },
  { abbr: 'CAR', name: 'Carolina Panthers',      short: 'Panthers',   conf: 'NFC', div: 'South' },
  { abbr: 'CHI', name: 'Chicago Bears',          short: 'Bears',      conf: 'NFC', div: 'North' },
  { abbr: 'CIN', name: 'Cincinnati Bengals',     short: 'Bengals',    conf: 'AFC', div: 'North' },
  { abbr: 'CLE', name: 'Cleveland Browns',       short: 'Browns',     conf: 'AFC', div: 'North' },
  { abbr: 'DAL', name: 'Dallas Cowboys',         short: 'Cowboys',    conf: 'NFC', div: 'East' },
  { abbr: 'DEN', name: 'Denver Broncos',         short: 'Broncos',    conf: 'AFC', div: 'West' },
  { abbr: 'DET', name: 'Detroit Lions',          short: 'Lions',      conf: 'NFC', div: 'North' },
  { abbr: 'GB',  name: 'Green Bay Packers',      short: 'Packers',    conf: 'NFC', div: 'North' },
  { abbr: 'HOU', name: 'Houston Texans',         short: 'Texans',     conf: 'AFC', div: 'South' },
  { abbr: 'IND', name: 'Indianapolis Colts',     short: 'Colts',      conf: 'AFC', div: 'South' },
  { abbr: 'JAX', name: 'Jacksonville Jaguars',   short: 'Jaguars',    conf: 'AFC', div: 'South' },
  { abbr: 'KC',  name: 'Kansas City Chiefs',     short: 'Chiefs',     conf: 'AFC', div: 'West' },
  { abbr: 'LAC', name: 'Los Angeles Chargers',   short: 'Chargers',   conf: 'AFC', div: 'West' },
  { abbr: 'LAR', name: 'Los Angeles Rams',       short: 'Rams',       conf: 'NFC', div: 'West' },
  { abbr: 'LV',  name: 'Las Vegas Raiders',      short: 'Raiders',    conf: 'AFC', div: 'West' },
  { abbr: 'MIA', name: 'Miami Dolphins',         short: 'Dolphins',   conf: 'AFC', div: 'East' },
  { abbr: 'MIN', name: 'Minnesota Vikings',      short: 'Vikings',    conf: 'NFC', div: 'North' },
  { abbr: 'NE',  name: 'New England Patriots',   short: 'Patriots',   conf: 'AFC', div: 'East' },
  { abbr: 'NO',  name: 'New Orleans Saints',     short: 'Saints',     conf: 'NFC', div: 'South' },
  { abbr: 'NYG', name: 'New York Giants',        short: 'Giants',     conf: 'NFC', div: 'East' },
  { abbr: 'NYJ', name: 'New York Jets',          short: 'Jets',       conf: 'AFC', div: 'East' },
  { abbr: 'PHI', name: 'Philadelphia Eagles',    short: 'Eagles',     conf: 'NFC', div: 'East' },
  { abbr: 'PIT', name: 'Pittsburgh Steelers',    short: 'Steelers',   conf: 'AFC', div: 'North' },
  { abbr: 'SEA', name: 'Seattle Seahawks',       short: 'Seahawks',   conf: 'NFC', div: 'West' },
  { abbr: 'SF',  name: 'San Francisco 49ers',    short: '49ers',      conf: 'NFC', div: 'West' },
  { abbr: 'TB',  name: 'Tampa Bay Buccaneers',   short: 'Buccaneers', conf: 'NFC', div: 'South' },
  { abbr: 'TEN', name: 'Tennessee Titans',       short: 'Titans',     conf: 'AFC', div: 'South' },
  { abbr: 'WSH', name: 'Washington Commanders',  short: 'Commanders', conf: 'NFC', div: 'East' },
];

const BY_ABBR = new Map(TEAMS.map((t) => [t.abbr, t]));

export const team = (abbr) => BY_ABBR.get(abbr) ?? null;
export const teamName = (abbr) => BY_ABBR.get(abbr)?.name ?? abbr;
export const teamShort = (abbr) => BY_ABBR.get(abbr)?.short ?? abbr;
export const ABBRS = TEAMS.map((t) => t.abbr);

/** Grouped for the board, which reads by conference then division. */
export function byDivision() {
  const out = new Map();
  for (const t of TEAMS) {
    const k = `${t.conf} ${t.div}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(t);
  }
  return out;
}
