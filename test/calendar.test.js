/**
 * The calendar export.
 *
 * Two halves, tested apart because they fail differently. `planReminders`
 * decides policy — who gets an alarm and what it says — and its failures are
 * visible: a reminder for a dead entry, an alarm about a game that has already
 * kicked off. `toIcs` only has to be RFC 5545-correct, and its failures are
 * not visible at all: a calendar that dislikes a file imports nothing and says
 * nothing, so every one of those rules is asserted here rather than trusted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planReminders, planSeasonDeadlines, toIcs, escapeText, foldLine,
  icsStamp, icsFilename, DEFAULT_ALARMS,
} from '../deadpool/src/engine/calendar.js';

const SEASON = 2026;
const SUNDAY = Date.parse('2026-09-13T17:00:00Z');
const THURSDAY = Date.parse('2026-09-10T00:20:00Z');
const TUESDAY = Date.parse('2026-09-08T12:00:00Z');

const entries = [{ id: 'A', name: 'Entry A' }, { id: 'B', name: 'Entry B' }];

const game = (over = {}) => ({
  eventId: '1', week: 1, state: 'pre', startDate: '2026-09-13T17:00:00Z', ...over,
});

const pick = (over = {}) => ({
  id: '2026-01-A', entry: 'A', season: SEASON, week: 1, team: 'KC', opponent: 'DEN',
  startDate: '2026-09-13T17:00:00Z', result: 'pending', strategyId: 'joint',
  snapshot: { winPct: 82.4 }, ...over,
});

/* ------------------------------------------------------------ formatting -- */

test('a stamp is iCalendar UTC, whatever the machine timezone', () => {
  assert.equal(icsStamp(new Date('2026-09-13T17:00:00Z')), '20260913T170000Z');
  assert.equal(icsStamp(new Date('2026-01-04T05:06:07Z')), '20260104T050607Z');
});

test('an unparseable date gives null rather than an Invalid Date in the file', () => {
  assert.equal(icsStamp(new Date('nonsense')), null);
  assert.equal(icsStamp('nonsense'), null);
});

test('TEXT escaping covers exactly what the spec lists', () => {
  assert.equal(escapeText('a;b'), 'a\\;b');
  assert.equal(escapeText('a,b'), 'a\\,b');
  assert.equal(escapeText('a\\b'), 'a\\\\b');
  assert.equal(escapeText('a\nb'), 'a\\nb');
  assert.equal(escapeText('a\r\nb'), 'a\\nb', 'CRLF is one newline, not two');
});

test('a colon is NOT escaped, which is the common overreach', () => {
  // RFC 5545 3.3.11 lists backslash, semicolon, comma and newline. Escaping
  // the colon renders a literal \: inside every description carrying a time.
  assert.equal(escapeText('kickoff at 13:00'), 'kickoff at 13:00');
});

test('backslash is escaped first, so escapes are not escaped twice', () => {
  // Wrong order gives 'a\\\\;b' — the backslash pass eating its own output.
  assert.equal(escapeText('a\\;b'), 'a\\\\\\;b');
});

test('a short line is left alone', () => {
  assert.equal(foldLine('SUMMARY:KC'), 'SUMMARY:KC');
});

test('a long line folds at 75 octets with a leading space on the continuation', () => {
  const line = `SUMMARY:${'x'.repeat(200)}`;
  const folded = foldLine(line);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1, 'should have folded');
  assert.ok(parts[0].length <= 75, `first segment was ${parts[0].length}`);
  for (const p of parts.slice(1)) {
    assert.equal(p[0], ' ', 'a continuation begins with one space');
    assert.ok(Buffer.byteLength(p, 'utf8') <= 75, 'including its space');
  }
  // Unfolding must give back exactly what went in.
  assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), line);
});

test('folding counts octets, and never splits a multi-byte character', () => {
  // The bug this exists for: fold by character count and a UTF-8 sequence gets
  // cut in half, which is a file no client will open.
  const line = `SUMMARY:${'é'.repeat(60)}`;
  const folded = foldLine(line);
  for (const part of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(part, 'utf8') <= 75, `segment was ${Buffer.byteLength(part, 'utf8')} octets`);
  }
  const unfolded = folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join('');
  assert.equal(unfolded, line, 'and it round-trips');
});

test('a line of exactly 75 octets does not fold', () => {
  const line = 'A'.repeat(75);
  assert.equal(foldLine(line), line);
  assert.ok(foldLine('A'.repeat(76)).includes('\r\n'));
});

/* --------------------------------------------------------------- policy -- */

test('a pick that has not kicked off gets one alarm', () => {
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [pick()], games: [game()], now: TUESDAY });
  const own = r.find((x) => x.kind === 'pick');
  assert.ok(own, 'the pick should be on the calendar');
  assert.deepEqual(own.alarms, [Math.min(...DEFAULT_ALARMS)]);
  assert.match(own.title, /Entry A · KC vs DEN/);
});

test('a pick whose game has kicked off is a record, with no alarm', () => {
  // An alarm about a decision nobody can change any more is how an app gets
  // muted, and a muted app does not remind you the week it matters.
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [pick()], games: [game()], now: SUNDAY + 3.6e6 });
  const own = r.find((x) => x.uid.endsWith('-pick'));
  assert.equal(own.kind, 'played');
  assert.deepEqual(own.alarms, []);
});

test('an entry with no pick gets a deadline at the first kickoff, with both alarms', () => {
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [], games: [game()], now: TUESDAY });
  const due = r.filter((x) => x.kind === 'deadline');
  assert.equal(due.length, 2, 'both entries are unpicked');
  assert.deepEqual(due[0].alarms, [...DEFAULT_ALARMS]);
  assert.equal(due[0].startsAt, SUNDAY);
});

test('the deadline is the first kickoff still ahead, not the week first game', () => {
  // A pick's window closes at its own kickoff. Once Thursday night has started,
  // the deadline that matters is Sunday's — using Thursday would put the alarm
  // in the past and the calendar would never fire it.
  const games = [game({ eventId: 'thu', startDate: '2026-09-10T00:20:00Z', state: 'post' }), game()];
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [], games, now: THURSDAY + 3.6e6 });
  assert.equal(r.find((x) => x.kind === 'deadline').startsAt, SUNDAY);
});

test('an eliminated entry is not reminded to make a pick it cannot make', () => {
  const statuses = { A: { alive: false }, B: { alive: true } };
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [], games: [game()], statuses, now: TUESDAY });
  const live = r.filter((x) => x.kind === 'deadline' && !x.cancelled);
  assert.deepEqual(live.map((d) => d.entryId), ['B']);
});

test('an entry that has already picked gets no live deadline', () => {
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [pick()], games: [game()], now: TUESDAY });
  const live = r.filter((x) => x.kind === 'deadline' && !x.cancelled);
  assert.deepEqual(live.map((d) => d.entryId), ['B']);
});

/**
 * Retraction — the case an .ics export has to handle explicitly, because an
 * import adds and updates and never deletes.
 *
 * Without this, a file exported before you picked leaves its "pick due" alarm
 * in the calendar forever, and it fires on Sunday about a pick you already
 * made. These assert that the retraction is emitted, that it is silent, and
 * that it is RFC-shaped enough for a client to act on.
 */
test('picking retracts the deadline rather than merely omitting it', () => {
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [pick()], games: [game()], now: TUESDAY });
  const retracted = r.find((x) => x.uid === `${SEASON}-w1-A-due`);
  assert.ok(retracted, 'the stale reminder must still be addressed, not dropped');
  assert.equal(retracted.cancelled, true);
  assert.deepEqual(retracted.alarms, [], 'a retraction never rings');
});

test('being eliminated retracts it too', () => {
  const statuses = { A: { alive: false }, B: { alive: true } };
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [], games: [game()], statuses, now: TUESDAY });
  const retracted = r.find((x) => x.uid === `${SEASON}-w1-A-due`);
  assert.ok(retracted && retracted.cancelled);
  assert.deepEqual(retracted.alarms, []);
});

test('a retraction carries STATUS:CANCELLED and a bumped SEQUENCE', () => {
  // Same UID, higher sequence, cancelled — which is how RFC 5545 says to
  // withdraw an event. Anything less and a compliant client keeps the old one.
  const ics = toIcs(
    planReminders({ season: SEASON, week: 1, entries, picks: [pick()], games: [game()], now: TUESDAY }),
    { now: new Date(TUESDAY) },
  );
  assert.ok(ics.includes('STATUS:CANCELLED'), 'no retraction in the file');
  assert.ok(ics.includes('SEQUENCE:1'), 'a retraction needs a higher sequence than the original');

  // And the retracted event carries no alarm, which is the part that actually
  // stops the phone going off.
  const block = ics.split('BEGIN:VEVENT').find((b) => b.includes(`${SEASON}-w1-A-due`));
  assert.ok(block && !block.includes('BEGIN:VALARM'), 'a retracted reminder must not still ring');
});

test('a live deadline carries no cancellation, so nothing retracts it by accident', () => {
  const ics = toIcs(
    planReminders({ season: SEASON, week: 1, entries, picks: [], games: [game()], now: TUESDAY }),
    { now: new Date(TUESDAY) },
  );
  assert.ok(!ics.includes('STATUS:CANCELLED'));
  assert.ok(!ics.includes('SEQUENCE:'));
});

test('the recommendation travels inside the reminder, which is the whole point', () => {
  // An alarm saying "open the app" competes with everything else on a Sunday
  // morning. One saying "take Kansas City" has already done the job.
  const recommendations = { A: { teamAbbreviation: 'KC', opponentAbbreviation: 'DEN', winPct: 82.4 } };
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [], games: [game()], recommendations, now: TUESDAY });
  const due = r.find((x) => x.entryId === 'A');
  assert.match(due.description, /Suggested: KC vs DEN \(82\.4% to advance\)/);
});

test('a recommendation is stamped as a snapshot rather than stated flatly', () => {
  const recommendations = { A: { teamAbbreviation: 'KC', winPct: 82.4 } };
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [], games: [game()], recommendations, now: TUESDAY });
  assert.match(r.find((x) => x.entryId === 'A').description, /As of when this calendar was exported/);
});

test('an estimated probability says so in the reminder, as it does on screen', () => {
  const recommendations = { A: { teamAbbreviation: 'KC', winPct: 66.8, winPctSource: 'spread_estimate' } };
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [], games: [game()], recommendations, now: TUESDAY });
  assert.match(r.find((x) => x.entryId === 'A').description, /Estimated from the spread/);
});

test('a pick with no kickoff time is dropped rather than placed at the epoch', () => {
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [pick({ startDate: null })], games: [], now: TUESDAY });
  assert.equal(r.filter((x) => x.uid.endsWith('-pick')).length, 0);
});

test('picks from another season are not on this season calendar', () => {
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [pick({ season: 2025 })], games: [], now: TUESDAY });
  assert.equal(r.length, 0);
});

test('with every game kicked off there is no deadline to set', () => {
  const r = planReminders({ season: SEASON, week: 1, entries, picks: [], games: [game({ state: 'post' })], now: SUNDAY + 8.64e7 });
  assert.equal(r.filter((x) => x.kind === 'deadline').length, 0);
});

test('reminders come out in time order, and a uid is stable', () => {
  const args = { season: SEASON, week: 1, entries, picks: [pick()], games: [game()], now: TUESDAY };
  const a = planReminders(args);
  const b = planReminders(args);
  assert.deepEqual(a.map((x) => x.uid), b.map((x) => x.uid), 'same input, same uids');
  for (let i = 1; i < a.length; i += 1) assert.ok(a[i].startsAt >= a[i - 1].startsAt);
});

/* ---------------------------------------------------------- the document -- */

const build = (over = {}) => toIcs(
  planReminders({ season: SEASON, week: 1, entries, picks: [pick()], games: [game()], now: TUESDAY, ...over }),
  { now: new Date(TUESDAY) },
);

test('the document has the envelope every client requires', () => {
  const ics = build();
  for (const line of ['BEGIN:VCALENDAR', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'END:VCALENDAR']) {
    assert.ok(ics.includes(line), `missing ${line}`);
  }
  assert.match(ics, /PRODID:-\/\/averageideas\/\/Deadpool\/\/EN/);
});

test('every line ends CRLF, including the last', () => {
  const ics = build();
  assert.ok(ics.endsWith('\r\n'), 'the file must end with a CRLF');
  // No bare LF anywhere: split on CRLF and nothing should still contain one.
  for (const line of ics.split('\r\n')) {
    assert.ok(!line.includes('\n'), `bare LF in: ${JSON.stringify(line)}`);
  }
});

test('no line exceeds 75 octets anywhere in the document', () => {
  // Long entry names and a description carrying a recommendation are how this
  // gets breached in practice, so build the worst realistic case.
  const ics = toIcs(planReminders({
    season: SEASON,
    week: 1,
    entries: [{ id: 'A', name: 'The Fellowship of the Miserable Sunday Afternoon' }],
    picks: [],
    games: [game()],
    recommendations: { A: { teamAbbreviation: 'KC', opponentAbbreviation: 'DEN', winPct: 82.4, winPctSource: 'spread_estimate' } },
    now: TUESDAY,
  }), { now: new Date(TUESDAY) });

  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `${Buffer.byteLength(line, 'utf8')} octets: ${line.slice(0, 40)}…`);
  }
});

test('every VEVENT is balanced and carries the required properties', () => {
  const ics = build({ picks: [] });
  const begins = ics.match(/BEGIN:VEVENT/g) ?? [];
  const ends = ics.match(/END:VEVENT/g) ?? [];
  assert.equal(begins.length, ends.length);
  assert.ok(begins.length > 0);
  for (const prop of ['UID:', 'DTSTAMP:', 'DTSTART:', 'DTEND:', 'SUMMARY:']) {
    assert.equal((ics.match(new RegExp(prop, 'g')) ?? []).length, begins.length, `one ${prop} per event`);
  }
});

test('every VALARM is balanced and has an ACTION and a TRIGGER', () => {
  const ics = build({ picks: [] });
  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, (ics.match(/END:VALARM/g) ?? []).length);
  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, (ics.match(/ACTION:DISPLAY/g) ?? []).length);
  assert.match(ics, /TRIGGER:-PT1440M/);
  assert.match(ics, /TRIGGER:-PT90M/);
});

test('an event ends after it starts', () => {
  const ics = build();
  const starts = [...ics.matchAll(/DTSTART:(\d{8}T\d{6}Z)/g)].map((m) => m[1]);
  const ends = [...ics.matchAll(/DTEND:(\d{8}T\d{6}Z)/g)].map((m) => m[1]);
  assert.equal(starts.length, ends.length);
  for (let i = 0; i < starts.length; i += 1) assert.ok(ends[i] > starts[i], `${ends[i]} should follow ${starts[i]}`);
});

test('picks are marked free, so a season does not block every Sunday', () => {
  assert.match(build(), /TRANSP:TRANSPARENT/);
});

test('the document is pure — same input and clock, same bytes', () => {
  assert.equal(build(), build());
});

test('a name with a comma in it does not break the SUMMARY', () => {
  const ics = toIcs(planReminders({
    season: SEASON, week: 1, entries: [{ id: 'A', name: 'Hook, Line and Sinker' }],
    picks: [], games: [game()], now: TUESDAY,
  }), { now: new Date(TUESDAY) });
  assert.match(ics, /Hook\\, Line and Sinker/);
});

test('an empty plan still produces a valid, empty calendar', () => {
  const ics = toIcs([], { now: new Date(TUESDAY) });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 0);
});

test('the filename names the season', () => {
  assert.equal(icsFilename(2026), 'deadpool-2026.ics');
});

/* ------------------------------------------------ the subscribable feed -- */

/**
 * The feed carries deadlines and nothing else, and most of what is asserted
 * here is that it stays that way. A pick or a recommendation appearing in a
 * subscribed calendar is the failure this design exists to avoid — a client
 * refreshes on its own schedule, so a pick in here is Wednesday's answer shown
 * confidently on Sunday.
 */
const feedGame = (over = {}) => ({
  eventId: 'g1', week: 1, state: 'pre', startDate: '2026-09-13T17:00:00Z',
  home: { abbreviation: 'KC' }, away: { abbreviation: 'DEN' },
  odds: { spread: -9.5 }, ...over,
});

const seasonWeeks = () => ({
  1: [feedGame(), feedGame({ eventId: 'g2', startDate: '2026-09-13T20:00:00Z', home: { abbreviation: 'BUF' }, away: { abbreviation: 'NYJ' }, odds: { spread: -6.5 } })],
  2: [feedGame({ eventId: 'g3', week: 2, startDate: '2026-09-20T17:00:00Z', home: { abbreviation: 'SF' }, away: { abbreviation: 'ARI' }, odds: { spread: -7.5 } })],
});

const AUG = new Date('2026-08-01T00:00:00Z');

test('one deadline per week, at that week first kickoff', () => {
  const plan = planSeasonDeadlines({ season: 2026, weeks: seasonWeeks(), now: AUG });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].week, 1);
  assert.equal(plan[0].startsAt, Date.parse('2026-09-13T17:00:00Z'), 'the earlier of week 1\'s two games');
  assert.equal(plan[1].startsAt, Date.parse('2026-09-20T17:00:00Z'));
});

test('a week whose games have all kicked off is gone from the feed', () => {
  // This is what makes it worth generating per request rather than publishing
  // once: a fetch in week 9 must not deliver eight past reminders.
  const plan = planSeasonDeadlines({
    season: 2026, weeks: seasonWeeks(), now: new Date('2026-09-15T00:00:00Z'),
  });
  assert.deepEqual(plan.map((p) => p.week), [2]);
});

test('a started game does not set the deadline for a week still open', () => {
  const weeks = {
    1: [
      feedGame({ eventId: 'thu', startDate: '2026-09-10T00:20:00Z', state: 'post' }),
      feedGame({ eventId: 'sun', startDate: '2026-09-13T17:00:00Z' }),
    ],
  };
  const plan = planSeasonDeadlines({ season: 2026, weeks, now: new Date('2026-09-11T00:00:00Z') });
  assert.equal(plan[0].startsAt, Date.parse('2026-09-13T17:00:00Z'));
});

test('both alarms are on every deadline', () => {
  const plan = planSeasonDeadlines({ season: 2026, weeks: seasonWeeks(), now: AUG });
  for (const p of plan) assert.deepEqual(p.alarms, [...DEFAULT_ALARMS]);
});

test('the feed carries no pick, no entry and no recommendation', () => {
  // The load-bearing assertion. Everything else here is arithmetic; this is
  // the design decision, and it is the one somebody would undo by accident.
  const ics = toIcs(
    planSeasonDeadlines({ season: 2026, weeks: seasonWeeks(), now: AUG }),
    { now: AUG, calendarName: 'Deadpool 2026' },
  );
  // Not "pick due" — that is the feed's own title and is exactly what it is
  // for. What must never appear is anything *personal*: an entry's name, a
  // suggested team, a recorded result, a strategy that chose one.
  for (const word of ['Entry A', 'Entry B', 'Suggested:', 'Chosen by', 'Recorded result', 'No pick recorded']) {
    assert.ok(!ics.includes(word), `the feed must not mention "${word}"`);
  }
  // And it names no team as a pick. The favourites list is the one place teams
  // appear, and it is guarded by its own test for the disclaimer beside it.
  assert.ok(!/SUMMARY:[^\r\n]*\b(KC|BUF|SF)\b/.test(ics), 'no team in an event title');
});

test('the favourites are labelled as not accounting for your used teams', () => {
  // Without that sentence a list of good teams reads as advice, and the feed
  // has no idea which of them you have already spent.
  const plan = planSeasonDeadlines({ season: 2026, weeks: seasonWeeks(), now: AUG });
  assert.match(plan[0].description, /before your used teams are taken out/);
  assert.match(plan[0].description, /does not know which teams you have spent/);
});

test('the favourites are ordered best first and match the engine own curve', async () => {
  const { estimateWinPctFromSpread } = await import('../deadpool/src/engine/win-prob.js');
  const plan = planSeasonDeadlines({ season: 2026, weeks: seasonWeeks(), now: AUG });
  // KC -9.5 at home beats BUF -6.5 at home, so KC leads.
  assert.match(plan[0].description, /KC vs DEN/);
  assert.ok(plan[0].description.indexOf('KC vs DEN') < plan[0].description.indexOf('BUF vs NYJ'));
  // And the figure is the engine's, not a second curve. The first version of
  // sideWinPct copied the logistic constants out of win-prob.js and got both
  // of them wrong, which is why this compares against the real function.
  const expected = estimateWinPctFromSpread(-9.5, true).toFixed(0);
  assert.ok(plan[0].description.includes(`KC vs DEN ${expected}%`),
    `expected KC at ${expected}% in: ${plan[0].description}`);
});

test('a week with no lines yet gets a reminder with no favourites in it', () => {
  const weeks = { 5: [feedGame({ week: 5, startDate: '2026-10-11T17:00:00Z', odds: null })] };
  const plan = planSeasonDeadlines({ season: 2026, weeks, now: AUG });
  assert.equal(plan.length, 1);
  assert.ok(!plan[0].description.includes('Biggest favourites'));
});

test('an empty season is a valid empty calendar rather than an error', () => {
  // The right answer in February. A subscriber keeps the subscription and it
  // fills itself in; erroring would make them re-add it.
  const ics = toIcs(planSeasonDeadlines({ season: 2026, weeks: {}, now: AUG }), { now: AUG });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('the feed folds and escapes like every other document here', () => {
  const ics = toIcs(planSeasonDeadlines({ season: 2026, weeks: seasonWeeks(), now: AUG }), { now: AUG });
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `${Buffer.byteLength(line, 'utf8')} octets`);
  }
  assert.ok(ics.endsWith('\r\n'));
});

test('uids are stable across regeneration, so a resubscribe does not duplicate', () => {
  const a = planSeasonDeadlines({ season: 2026, weeks: seasonWeeks(), now: AUG });
  const b = planSeasonDeadlines({ season: 2026, weeks: seasonWeeks(), now: AUG });
  assert.deepEqual(a.map((p) => p.uid), b.map((p) => p.uid));
  assert.deepEqual(a.map((p) => p.uid), ['2026-w1-lock', '2026-w2-lock']);
});
