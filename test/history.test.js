/**
 * Putting a wrong pick right.
 *
 * A pick recorded wrong used to stand for the season once its game kicked
 * off. The Week screen's "Change" closes at kickoff, correctly, and the Season
 * screen could only step a result through its four values — so a tap on the
 * wrong card, or a week never tapped in at all, had no way back. Everything in
 * the app is derived from the log, which made one wrong team a spent team
 * offered again and an entry scored on a game it never played.
 *
 * Four groups: the derivations the correction panel is drawn from; the store
 * operations it writes through, whose undo has to be exact; which copies of a
 * game may settle a corrected pick; and the Season screen's markup. Nothing in
 * this suite draws a page, so the last group renders the real view into a fake
 * element and reads it back — weaker than looking at it, and aimed at the
 * faults a diff hides: a control not rendered, a refusal with no reason on it.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installLocalStorage, freshStore } from './helpers/local-storage.js';
import {
  timeline, choicesFor, reassignment, correction, hasKickedOff, statusOf, settleable, pickId,
} from '../deadpool/src/store/derive.js';
import { weekGames, finalGames } from '../deadpool/src/data/source.js';
import { render as renderSeason } from '../deadpool/src/views/season.js';
import { ABBRS } from '../deadpool/src/data/teams.js';

beforeEach(() => { installLocalStorage(); });

const ENTRIES = [{ id: 'A', name: 'Entry A' }, { id: 'B', name: 'Entry B' }];

const pick = (entry, week, team, result = 'win', over = {}) => ({
  id: pickId(2026, week, entry), entry, season: 2026, week, team, result, ...over,
});

const game = (away, home, over = {}) => ({
  eventId: `${away}@${home}`, week: 2, seasonYear: 2026, state: 'pre', startDate: '2026-09-20T17:00:00Z',
  home: { abbreviation: home, score: null, winner: null },
  away: { abbreviation: away, score: null, winner: null },
  ...over,
});

const final = (g, homeScore, awayScore) => ({
  ...g,
  state: 'post',
  home: { ...g.home, score: homeScore, winner: homeScore > awayScore },
  away: { ...g.away, score: awayScore, winner: awayScore > homeScore },
});

const statesOf = (rows) => rows.map((r) => [r.week, ...r.cells.map((c) => c.state)]);

/* ------------------------------------------------------------ the rows -- */

test('a week nobody recorded is still a row, so the missing pick can be seen', () => {
  const picks = [pick('A', 1, 'KC'), pick('B', 1, 'SF'), pick('A', 3, 'BUF'), pick('B', 3, 'DET')];
  assert.deepEqual(statesOf(timeline(picks, 2026, ENTRIES, { through: 3 })),
    [[1, 'pick', 'pick'], [2, 'open', 'open'], [3, 'pick', 'pick']],
    'week 2 used to be skipped — and a skipped week is a spent team the app offers again');
});

test('an entry already out is owed nothing, so its later weeks offer nothing', () => {
  const picks = [pick('A', 1, 'KC'), pick('B', 1, 'SF', 'loss'), pick('A', 2, 'BUF')];
  assert.deepEqual(statesOf(timeline(picks, 2026, ENTRIES, { through: 3 })),
    [[1, 'pick', 'pick'], [2, 'pick', 'out'], [3, 'open', 'out']]);
});

test('the week out is counted by the pool\'s rules, not by the first loss', () => {
  const picks = [pick('B', 1, 'SF', 'loss'), pick('B', 2, 'DET')];
  const rows = timeline(picks, 2026, ENTRIES, { through: 2, options: { strikesAllowed: 2 } });
  assert.deepEqual(statesOf(rows), [[1, 'open', 'pick'], [2, 'open', 'pick']],
    'a two-strike pool is still in after one loss, so nothing after it is closed off');
});

test('the week on the board is not a row until something is recorded in it', () => {
  const picks = [pick('A', 1, 'KC'), pick('B', 1, 'SF')];
  assert.equal(timeline(picks, 2026, ENTRIES, { through: 2 }).length, 2,
    'week 3 is being picked on the Week screen; a row of blanks would read as already missed');
  picks.push(pick('A', 3, 'BUF', 'pending'));
  assert.equal(timeline(picks, 2026, ENTRIES, { through: 2 }).length, 3);
});

test('rows stop at the regular season, and a stray entry invents none', () => {
  assert.equal(timeline([], 2026, ENTRIES, { through: 40 }).length, 18);
  assert.equal(timeline([pick('C', 9, 'KC')], 2026, ENTRIES).length, 0,
    'a pick for an entry that is not listed has no cell to draw, so it cannot justify a row');
});

/* ---------------------------------------------------------- the choices -- */

test('the recorded team is current, and a team spent elsewhere says which week', () => {
  const picks = [pick('A', 1, 'KC'), pick('A', 2, 'BUF')];
  const by = new Map(choicesFor(picks, 'A', 2026, 2, null, ABBRS).map((c) => [c.abbr, c]));
  assert.equal(by.get('BUF').state, 'current');
  assert.equal(by.get('KC').state, 'used');
  assert.equal(by.get('KC').usedWeek, 1, 'struck out with the week, so the other wrong week can be found');
  assert.equal(by.get('SF').state, 'available');
});

test('with the week\'s games known, byes are closed and every team has its opponent', () => {
  const games = [game('NYJ', 'ATL'), game('KC', 'DEN')];
  const by = new Map(choicesFor([], 'A', 2026, 2, games, ['NYJ', 'ATL', 'KC', 'BUF']).map((c) => [c.abbr, c]));
  assert.equal(by.get('NYJ').game.opponent, 'ATL');
  assert.equal(by.get('ATL').game.opponent, 'NYJ', 'both sides of a game, whichever one was picked');
  assert.equal(by.get('BUF').state, 'bye');
});

test('with no games on the device, every team is still a choice', () => {
  const choices = choicesFor([], 'A', 2026, 2, null, ABBRS);
  assert.equal(choices.length, 32);
  assert.ok(choices.every((c) => c.state === 'available' && c.game === null),
    'offline is exactly when a correction may need making, so the list cannot depend on the schedule');
});

test('a game that is over is still a choice, because correcting it is the point', () => {
  const games = [final(game('NYJ', 'ATL'), 24, 17)];
  const by = new Map(choicesFor([], 'A', 2026, 2, games, ['NYJ', 'ATL']).map((c) => [c.abbr, c]));
  assert.equal(by.get('NYJ').state, 'available', 'the Week screen closes a started game; the record of one must stay open');
});

test('spent outranks a bye', () => {
  const picks = [pick('A', 1, 'KC')];
  const by = new Map(choicesFor(picks, 'A', 2026, 2, [game('NYJ', 'ATL')], ['KC', 'NYJ']).map((c) => [c.abbr, c]));
  assert.equal(by.get('KC').state, 'used', 'the week it was spent is the more useful thing to say');
});

/* ------------------------------------------------------- other entries -- */

test('a week the other entry left empty is a move, and one it filled is a swap', () => {
  const picks = [pick('A', 2, 'KC'), pick('A', 3, 'BUF'), pick('B', 3, 'SF')];
  assert.equal(reassignment(picks, picks[0], 'B').kind, 'move');
  assert.equal(reassignment(picks, picks[1], 'B').kind, 'swap');
  assert.equal(reassignment(picks, picks[1], 'B').blocked, null);
});

test('a hand-over that would spend a team twice is refused, naming the week', () => {
  const picks = [pick('A', 3, 'KC'), pick('B', 1, 'KC'), pick('B', 3, 'SF'), pick('A', 2, 'SF')];
  assert.deepEqual(reassignment(picks, picks[0], 'B').blocked,
    { reason: 'spent', entry: 'B', team: 'KC', week: 1 },
    'B already has KC in week 1');

  const back = [pick('A', 3, 'KC'), pick('B', 3, 'SF'), pick('A', 2, 'SF')];
  assert.deepEqual(reassignment(back, back[0], 'B').blocked,
    { reason: 'spent', entry: 'A', team: 'SF', week: 2 },
    'and the swap would hand A back a team it spent in week 2');
});

test('nothing is handed to an entry that was already out, but one out this week can swap', () => {
  const picks = [pick('B', 1, 'SF', 'loss'), pick('A', 3, 'KC'), pick('A', 1, 'DET')];
  assert.deepEqual(reassignment(picks, picks[1], 'B').blocked, { reason: 'out', entry: 'B', week: 1 });

  const same = [pick('A', 1, 'KC'), pick('B', 1, 'SF', 'loss')];
  assert.equal(reassignment(same, same[0], 'B').blocked, null,
    'the loss that put B out is the very pick that may belong to A — refusing it would lock the mistake in');
});

/* ------------------------------------------------------------- kickoff -- */

test('a result is asked for once the game has started, and not before', () => {
  const now = Date.parse('2026-09-20T18:00:00Z');
  assert.equal(hasKickedOff({ team: 'NYJ', startDate: '2026-09-20T17:00:00Z' }, null, now), true);
  assert.equal(hasKickedOff({ team: 'NYJ', startDate: '2026-09-27T17:00:00Z' }, null, now), false);
  assert.equal(hasKickedOff({ team: 'NYJ', startDate: '2026-09-27T17:00:00Z' }, [game('NYJ', 'ATL', { state: 'in' })], now), true,
    'a game in progress is in progress, whatever the stored kickoff says');
  assert.equal(hasKickedOff({ team: 'NYJ' }, null, now), true, 'with nothing to go on, the control is shown');
});

/* ---------------------------------------------------------- the writes -- */

test('a corrected team keeps nothing that was about the team it replaced', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 2, team: 'BAL', strategyId: 'joint', snapshot: { winPct: 88.1 } });
  s.setResult('2026-02-A', 'win');

  const { ok, pick: fixed, previous } = s.correctPick({
    entry: 'A', season: 2026, week: 2, team: 'BUF',
    game: { opponent: 'HOU', eventId: 'e7', startDate: '2026-09-20T17:00:00Z' },
  });
  assert.equal(ok, true);
  assert.equal(fixed.team, 'BUF');
  assert.equal(fixed.opponent, 'HOU');
  assert.equal(fixed.eventId, 'e7', 'the game id is what lets it settle, and the calendar place it');
  assert.equal(fixed.snapshot, null, '"88.1% when picked" was a number about Baltimore');
  assert.equal(fixed.strategyId, null, 'and no strategy ever recommended Buffalo here');
  assert.equal(fixed.result, 'pending', 'the win belonged to the other game');
  assert.equal(fixed.source, 'correction');
  assert.equal(previous.team, 'BAL');
});

test('correcting to the team already recorded changes nothing, not even the snapshot', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 2, team: 'BAL', strategyId: 'joint', snapshot: { winPct: 88.1 } });
  const before = s.pickAtWeek('A', 2, 2026);
  const r = s.correctPick({ entry: 'A', season: 2026, week: 2, team: 'BAL' });
  assert.equal(r.unchanged, true);
  assert.deepEqual(s.pickAtWeek('A', 2, 2026), before, 're-recording would have wiped what this exists to protect');
});

test('undoing a correction puts the old pick back exactly, and an added week goes again', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 2, team: 'BAL', snapshot: { winPct: 88.1 } });
  s.setResult('2026-02-A', 'win');
  const original = s.pickAtWeek('A', 2, 2026);

  const { previous } = s.correctPick({ entry: 'A', season: 2026, week: 2, team: 'BUF' });
  s.restorePick(previous);
  assert.deepEqual(s.pickAtWeek('A', 2, 2026), original);

  const added = s.correctPick({ entry: 'A', season: 2026, week: 1, team: 'KC' });
  assert.equal(added.previous, null, 'a week that was empty');
  s.removePick(added.pick.id);
  assert.equal(s.pickAtWeek('A', 1, 2026), null);
});

test('status follows a correction, because nothing is stored twice', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 1, team: 'NYJ' });
  s.setResult('2026-01-A', 'loss');
  assert.equal(s.statusFor('A', 2026).alive, false);
  s.correctPick({ entry: 'A', season: 2026, week: 1, team: 'NO' });
  assert.equal(s.statusFor('A', 2026).alive, true, 'the loss was the wrong team\'s, and went with it');
  assert.deepEqual(s.usedTeamsFor('A', 2026), ['NO']);
});

test('a move hands over the whole pick and empties the week it left', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 3, team: 'SF', strategyId: 'joint', snapshot: { winPct: 93.6 } });
  s.setResult('2026-03-A', 'win');
  const original = s.pickAtWeek('A', 3, 2026);

  const r = s.reassignPick('2026-03-A', 'B');
  assert.equal(r.ok, true);
  assert.equal(s.pickAtWeek('A', 3, 2026), null);
  assert.deepEqual(s.pickAtWeek('B', 3, 2026), { ...original, id: '2026-03-B', entry: 'B' },
    'the pick was right; only the card it was tapped on was wrong, so everything else travels');

  s.restoreSlots(r.slots, r.previous);
  assert.deepEqual(s.pickAtWeek('A', 3, 2026), original);
  assert.equal(s.pickAtWeek('B', 3, 2026), null, 'undone by emptying the slot it moved to, not leaving a copy');
});

test('a swap exchanges two picks without touching what is in them', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 3, team: 'SF', snapshot: { winPct: 93.6 } });
  s.recordPick({ entry: 'B', season: 2026, week: 3, team: 'MIN', snapshot: { winPct: 94.3 } });
  s.setResult('2026-03-B', 'loss');
  const [a, b] = [s.pickAtWeek('A', 3, 2026), s.pickAtWeek('B', 3, 2026)];

  const r = s.reassignPick('2026-03-A', 'B');
  assert.deepEqual(s.pickAtWeek('A', 3, 2026), { ...b, id: a.id, entry: 'A' });
  assert.deepEqual(s.pickAtWeek('B', 3, 2026), { ...a, id: b.id, entry: 'B' });
  assert.equal(s.statusFor('A', 2026).alive, false, 'the loss went with the team to A');

  s.restoreSlots(r.slots, r.previous);
  assert.deepEqual([s.pickAtWeek('A', 3, 2026), s.pickAtWeek('B', 3, 2026)], [a, b]);
});

test('a refused write leaves both halves of a swap where they were', async () => {
  const s = await freshStore(); s.load();
  s.recordPick({ entry: 'A', season: 2026, week: 3, team: 'SF' });
  s.recordPick({ entry: 'B', season: 2026, week: 3, team: 'MIN' });
  const before = s.getPicks();

  installLocalStorage({ blocked: true });
  const r = s.reassignPick('2026-03-A', 'B');
  assert.equal(r.ok, false);
  assert.deepEqual(s.getPicks(), before, 'memory is put back, so the screen cannot show a swap the disk does not hold');
  assert.equal(s.storage.currentAlarm().kind, 'blocked', 'and the refusal is on screen');
});

/* ------------------------------------------------ which copies may settle -- */

test('a week\'s games come from the board, then the cache, then the schedule', () => {
  const g = [game('NYJ', 'ATL')];
  const schedule = { season: 2026, weeks: { 2: [game('KC', 'DEN')] } };
  assert.equal(weekGames({ season: 2026, week: 2 }, { board: { season: 2026, week: 2, games: g }, schedule }), g);
  assert.equal(weekGames({ season: 2026, week: 2 }, { board: { season: 2026, week: 3, games: g }, schedule })[0].eventId, 'KC@DEN',
    'the board is a different week, so it is not this one');
  assert.equal(weekGames({ season: 2026, week: 2 }, { cached: { games: g }, schedule }), g);
  assert.equal(weekGames({ season: 2026, week: 2 }, { schedule: { season: 2025, weeks: schedule.weeks } }), null,
    'last season\'s week 2 is not this season\'s');
});

test('a copy saved at half time cannot hide the final score behind it', () => {
  const pending = [pick('A', 2, 'NYJ', 'pending', { eventId: 'NYJ@ATL' })];
  const halfTime = { games: [game('NYJ', 'ATL', { state: 'in' })] };
  const schedule = { season: 2026, weeks: { 2: [final(game('NYJ', 'ATL'), 17, 24)] } };

  assert.deepEqual(settleable(pending, [...halfTime.games, ...schedule.weeks[2]]), [],
    'the resolver stops at the first copy of a game — which is why the copies are filtered first');
  const games = finalGames({ season: 2026, weeks: [2] }, { cachedWeeks: [halfTime], schedule });
  assert.deepEqual(settleable(pending, games), [{ id: pending[0].id, result: 'win' }]);
});

test('a game still being played settles nothing, from any copy', () => {
  const pending = [pick('A', 2, 'NYJ', 'pending', { eventId: 'NYJ@ATL' })];
  const games = finalGames({ season: 2026, weeks: [2] }, {
    board: { games: [game('NYJ', 'ATL', { state: 'in' })] },
    schedule: { season: 2026, weeks: { 2: [game('NYJ', 'ATL')] } },
  });
  assert.deepEqual(games, []);
  assert.deepEqual(settleable(pending, games), []);
});

/* ------------------------------------------------------- the Season screen -- */

/**
 * The Season view, drawn from the same derivations the app hands it.
 * `fix` is the panel's `{ week, entry, teams }`, as held in app.js.
 */
function drawSeason(picks, { week = 3, fix = null, games = null, now = Date.parse('2026-09-25T12:00:00Z') } = {}) {
  const root = { innerHTML: '' };
  const through = Math.max(week - 1, fix?.week ?? 0);
  const panel = fix && correction(picks, ENTRIES, {
    season: 2026, week: fix.week, entry: fix.entry, weekGames: games, allAbbrs: ABBRS, now,
  });
  renderSeason(root, {
    entries: ENTRIES,
    season: 2026,
    week,
    timeline: timeline(picks, 2026, ENTRIES, { through }),
    statuses: Object.fromEntries(ENTRIES.map((e) => [e.id, statusOf(picks, e.id, 2026)])),
    fix: panel && { ...panel, teamsOpen: Boolean(fix.teams) || !panel.pick },
  });
  return root.innerHTML;
}

const count = (html, pattern) => [...html.matchAll(pattern)].length;

/**
 * The open panel's markup and what follows it. The card of results to record
 * sits above and carries result buttons of its own for every pending pick, so
 * a count over the whole page would be counting that card too.
 */
const panelOf = (html) => {
  const at = html.indexOf('class="card fix"');
  assert.ok(at >= 0, 'no correction panel was drawn');
  return html.slice(at);
};

test('every recorded pick and every owed week is a control, and none cycles a result blind', () => {
  const html = drawSeason([pick('A', 1, 'KC'), pick('B', 1, 'SF'), pick('A', 2, 'BUF')]);
  assert.equal(count(html, /data-act="fix"/g), 4, 'three picks and the one blank week B still owes');
  assert.equal(count(html, /data-act="cycle"/g), 0);
  assert.match(html, /Tap a pick to change its team, its result, or which entry it was for/,
    'the only affordance used to be a title= a phone never shows');
});

test('a blank week already played is flagged; a blank in the week on the board is not', () => {
  const html = drawSeason([pick('B', 1, 'SF'), pick('A', 3, 'KC', 'pending')], { week: 3 });
  assert.match(html, /class="tcell tcell--open tcell--missed"[^>]*data-key="fix-1-A"/, 'week 1 was played and A has nothing');
  assert.match(html, /class="tcell tcell--open"[^>]*data-key="fix-3-B"/, 'week 3 is still being picked');
  assert.match(html, /note--warn/, 'and the screen says what a missing week costs');
});

test('an entry already out gets no control for the weeks after', () => {
  const html = drawSeason([pick('A', 1, 'KC'), pick('B', 1, 'SF', 'loss'), pick('A', 2, 'BUF')]);
  assert.doesNotMatch(html, /data-key="fix-2-B"/);
});

test('the open panel shows the recorded result pressed, and only that one', () => {
  const html = drawSeason([pick('A', 1, 'KC', 'loss'), pick('B', 1, 'SF')], { fix: { week: 1, entry: 'A' } });
  const panel = panelOf(html);
  assert.match(panel, /Entry A · week 1/);
  assert.equal(count(panel, /data-act="result"/g), 4, 'won, lost, tied, and pending to hand it back');
  assert.match(panel, /class="btn btn--on" data-act="result"\s+data-id="2026-01-A" data-result="loss"/);
  assert.equal(count(panel, /aria-pressed="true"/g), 1);
  assert.match(html, /data-act="fix"[^>]*data-key="fix-1-A" aria-expanded="true"/, 'the cell says its panel is open');
});

test('before kickoff the panel asks for no result', () => {
  const picks = [pick('A', 3, 'KC', 'pending', { startDate: '2026-09-27T17:00:00Z' })];
  const panel = panelOf(drawSeason(picks, { fix: { week: 3, entry: 'A' } }));
  assert.equal(count(panel, /data-act="result"/g), 0);
  assert.match(panel, /A result goes in once the game kicks off/);
});

test('a refused swap is drawn disabled, with the week that refuses it', () => {
  const picks = [pick('A', 3, 'KC'), pick('B', 3, 'SF'), pick('B', 1, 'KC'), pick('A', 1, 'DET')];
  const html = drawSeason(picks, { week: 4, fix: { week: 3, entry: 'A' } });
  assert.match(html, /data-act="fix-move" data-to="B"\s+data-key="fix-move-B" disabled/);
  assert.match(html, /No swap: Entry B already used KC in week 1\.\s+If that is wrong, fix week 1 first\./);
});

test('the team grid strikes out spent teams with their week, and presses the recorded one', () => {
  const picks = [pick('A', 1, 'KC'), pick('A', 2, 'BUF')];
  const html = drawSeason(picks, { fix: { week: 2, entry: 'A', teams: true }, games: [game('BUF', 'HOU'), game('KC', 'DEN')] });
  assert.equal(count(html, /data-act="fix-team"/g), 32, 'every team, so any correction is possible');
  assert.match(html, /board__cell--used"[^>]*data-team="KC"[^>]*aria-label="KC, used in week 1"\s*disabled/);
  assert.match(html, /board__cell--current"[^>]*data-team="BUF"[^>]*aria-pressed="true"/);
  assert.match(html, /board__cell--bye"[^>]*data-team="MIA"[^>]*disabled/, 'Miami is not in this week\'s games');
  assert.match(html, /aria-label="HOU, against BUF"/);
});

test('an empty week opens straight onto the grid, with no toggle to find it behind', () => {
  const html = drawSeason([pick('B', 1, 'SF')], { fix: { week: 1, entry: 'A' } });
  assert.match(html, /Nothing is recorded for this week\. Tap the team Entry A picked\./);
  assert.equal(count(html, /data-act="fix-teams"/g), 0);
  assert.equal(count(html, /data-act="fix-team"/g), 32);
  assert.match(html, /schedule is not on this device/, 'and says why no team shows an opponent');
});
