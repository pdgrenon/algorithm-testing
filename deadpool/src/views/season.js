/**
 * The season — every week, both entries, and the one place the record of them
 * can be put right.
 *
 * This screen exists because of the single largest gap in the tool it wraps:
 * survivor-picker stores a flat list of used teams with no week and no
 * outcome, so it cannot say whether you are still in the pool. Everything else
 * in the app — alive or out, strikes, the record, the board, which teams a
 * strategy may still recommend — is derived from what is recorded here.
 *
 * Pending picks are pulled to the top rather than left in date order, because
 * the reason somebody opens this screen on a Monday is to clear them.
 *
 * ── What is left here now that results settle themselves ────────────────
 *
 * Most of them do not need clearing any more. A finished game settles its own
 * pick from the score the app already had (see `settleResults` in the store),
 * so what reaches this card is the residue: a game still being played, or one
 * this device holds no final score for. That is a much shorter list and a
 * more interesting one, and the copy says which it is rather than implying
 * somebody forgot.
 *
 * A result set by hand stays authoritative. A pool can rule a game in a way
 * ESPN does not — a forfeit, a suspended game, a scoring correction — and the
 * person is right and the feed is wrong. Anything set here is stamped
 * `manual`, and the automatic pass only ever looks at pending picks, so a
 * correction is never quietly reverted on the next refresh.
 *
 * ── Putting a pick right ─────────────────────────────────────────────────
 *
 * A pick recorded wrong used to be permanent once its game kicked off. The
 * Week screen's "Change" closes at kickoff, correctly — you cannot change the
 * pick you made — but that also closed the only way to change the *record* of
 * it, and a mis-tap on a Sunday then stood for the season: the right team
 * still offered as unspent, the wrong one burned, and the entry alive or out
 * on a game it never played.
 *
 * So every cell below is a control. Tapping one opens a card under its row —
 * the Week screen's entry card, in miniature, because it is the same object:
 * the team, "How did it go?", and the rest of the board behind a disclosure.
 * Tapping a blank week opens straight onto the board, since adding a team is
 * the only thing to do with it. Every change says what it did and can be
 * undone from the same line, and nothing asks for confirmation — an undo is
 * worth more than a dialog, and it is what the rest of the app does.
 *
 * This replaced tapping a cell to step it through pending, win, loss and tie.
 * That was one tap to reach the next result and three to reach the last one,
 * passing through "loss" on the way from "win" to "tie" — marking an entry
 * out and toasting it, as a side effect of trying to say it tied.
 */

import { esc, cx } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { byDivision } from '../data/teams.js';

const RESULT_CHIP = { win: 'chip--alive', loss: 'chip--out', tie: 'chip--warn', pending: '' };
const RESULT_SAID = { win: 'won', loss: 'lost', tie: 'tied', pending: 'no result yet' };

/** The Week screen's three buttons, plus a way back for a result set too soon. */
const RESULT_BUTTONS = [['win', 'Won'], ['loss', 'Lost'], ['tie', 'Tied'], ['pending', 'Pending']];

export function render(root, model) {
  const { entries, timeline, statuses, season, fix = null, week = null } = model;
  const pending = timeline.flatMap((r) => r.cells.filter((c) => c.pick && c.pick.result === 'pending').map((c) => ({ week: r.week, ...c })));

  root.innerHTML = `
    <section class="view">
      <div class="section-head">
        <span class="eyebrow">Season</span>
        <span class="status__week">${season}</span>
      </div>

      <div class="btn-row">
        ${entries.map((e) => {
          const s = statuses[e.id];
          return `<span class="${cx('chip', s.alive ? 'chip--alive' : 'chip--out')}">
            <i class="chip__dot"></i>${esc(e.name)} ${esc(s.alive ? s.record : `out wk ${s.eliminatedWeek}`)}
          </span>`;
        }).join('')}
      </div>

      ${pending.length ? renderPending(pending, entries) : ''}

      ${timeline.length ? renderWeeks(timeline, entries, fix, week) : renderEmpty()}
    </section>`;
  return root;
}

function renderPending(pending, entries) {
  const nameOf = (id) => entries.find((e) => e.id === id)?.name ?? id;
  return `
    <div class="card">
      <div class="card__head">
        <h2 class="card__title">${pending.length} result${pending.length === 1 ? '' : 's'} to record</h2>
      </div>
      <div class="card__body">
        <p class="note">
          Finished games settle themselves. These are the ones left — still being
          played, or a game this device has no final score for. Anything you set
          here is kept, and is not overwritten on the next refresh.
        </p>
      </div>
      <div>
        ${pending.map((p) => `
          <div class="card__body trow--divided">
            <div class="label">Week ${esc(p.week)} · ${esc(nameOf(p.entry))}</div>
            <div class="pick pick--single">
              <div class="pick__team">
                <span class="pick__abbr pick__abbr--sm">${esc(p.pick.team)}</span>
                <span class="pick__opp">${p.pick.opponent ? `vs ${esc(p.pick.opponent)}` : ''}</span>
              </div>
            </div>
            <div class="btn-row">
              <button type="button" class="btn" data-act="result" data-id="${esc(p.pick.id)}" data-result="win" data-key="${esc(p.pick.id)}-win">Won</button>
              <button type="button" class="btn" data-act="result" data-id="${esc(p.pick.id)}" data-result="loss" data-key="${esc(p.pick.id)}-loss">Lost</button>
              <button type="button" class="btn" data-act="result" data-id="${esc(p.pick.id)}" data-result="tie" data-key="${esc(p.pick.id)}-tie">Tied</button>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ------------------------------------------------------------ the weeks -- */

/**
 * A blank week before the one on the board is a pick nobody recorded, which
 * is the costly kind of blank; one in the current week is only not made yet.
 * With no week known at all every blank counts, because every row then comes
 * from a week somebody recorded a pick in.
 */
const isMissed = (rowWeek, week) => week === null || rowWeek < week;

function renderWeeks(timeline, entries, fix, week) {
  const recorded = timeline.some((r) => r.cells.some((c) => c.pick));
  const missed = timeline.some((r) => isMissed(r.week, week) && r.cells.some((c) => c.state === 'open'));
  const notes = [
    recorded ? '<p class="note">Tap a pick to change its team, its result, or which entry it was for.</p>' : '',
    missed ? `<p class="note note--warn">A week marked Add has no pick recorded. Until it has one, the team
      taken that week still counts as available — and can be recommended again.</p>` : '',
  ].join('');
  return `
    <div class="card">
      <div class="card__head">
        <h2 class="card__title">Every week</h2>
        <span class="label">${esc(entries.map((e) => e.name).join(' · '))}</span>
      </div>
      ${notes ? `<div class="card__body card__body--notes">${notes}</div>` : ''}
      <div class="trows">${timeline.map((row) => renderRow(row, entries, fix, week)).join('')}</div>
    </div>`;
}

function renderRow(row, entries, fix, week) {
  const open = fix && fix.week === row.week ? fix : null;
  return `
    <div class="trow">
      <span class="trow__week">W${esc(String(row.week).padStart(2, '0'))}</span>
      ${entries.map((e) => renderCell(row, e, open, week)).join('')}
    </div>
    ${open ? renderFix(open, entries) : ''}`;
}

function renderCell(row, entry, open, week) {
  const cell = row.cells.find((c) => c.entry === entry.id) ?? { state: 'open', pick: null };
  // Out before this week: nothing is owed, so nothing is offered. It comes
  // back the moment the week that knocked it out is corrected, because the
  // state is derived rather than stored.
  if (cell.state === 'out') return '<span class="tcell tcell--empty">—</span>';

  const on = open?.entry.id === entry.id;
  const attrs = `data-act="fix" data-week="${esc(row.week)}" data-entry="${esc(entry.id)}"
    data-key="fix-${esc(row.week)}-${esc(entry.id)}" aria-expanded="${on ? 'true' : 'false'}"`;

  if (!cell.pick) {
    return `
      <button type="button" class="${cx('tcell', 'tcell--open', isMissed(row.week, week) && 'tcell--missed', on && 'tcell--on')}" ${attrs}
              aria-label="Week ${esc(row.week)}, ${esc(entry.name)}: nothing recorded. Add a pick.">
        ${icon('plus', 14)}<span class="tcell__add">Add</span>
      </button>`;
  }

  const p = cell.pick;
  return `
    <button type="button" class="${cx('tcell', `tcell--${p.result}`, on && 'tcell--on')}" ${attrs}
            aria-label="Week ${esc(row.week)}, ${esc(entry.name)}: ${esc(p.team)}, ${esc(RESULT_SAID[p.result])}. Change it.">
      <span class="tcell__abbr">${esc(p.team)}</span>
      <span class="chip ${RESULT_CHIP[p.result]}">${esc(p.result === 'pending' ? '?' : p.result)}</span>
    </button>`;
}

/* ------------------------------------------------------ the correction -- */

/**
 * One entry's week, open for correcting.
 *
 * A card, and the Week screen's card at that: a head naming whose week it is,
 * the team large, "How did it go?", and the rest of the board behind the same
 * disclosure bar as "Pick something else". It is the same object as the card
 * a pick was made on, so it looks like one.
 *
 * Drawn in the brand's outline, and the cell that opened it too, because that
 * is what "this one" looks like everywhere else here — the selected strategy,
 * the selected entry tab, the focus ring.
 */
function renderFix(fix, entries) {
  const { week, entry, pick } = fix;
  return `
    <div class="card fix" role="group" aria-labelledby="fix-title">
      <div class="card__head">
        <h3 class="card__title fix__title" id="fix-title" tabindex="-1">${esc(entry.name)} · week ${esc(week)}</h3>
        <button type="button" class="btn btn--ghost" data-act="fix-close">Done</button>
      </div>
      ${pick ? renderFixPick(fix, entries) : renderFixEmpty(fix)}
    </div>`;
}

function renderFixEmpty(fix) {
  return `
    <div class="card__body">
      ${renderTeams(fix, `Nothing is recorded for this week. Tap the team ${fix.entry.name} picked`)}
    </div>`;
}

function renderFixPick(fix, entries) {
  const { pick, kickedOff, teamsOpen } = fix;
  return `
    <div class="card__body">
      <div class="pick pick--single">
        <div class="pick__team">
          <span class="pick__abbr pick__abbr--sm">${esc(pick.team)}</span>
          <span class="pick__opp">${pick.opponent ? `vs ${esc(pick.opponent)}` : 'Opponent not recorded'}</span>
        </div>
      </div>
      ${kickedOff ? renderResult(pick) : '<p class="field__help">A result goes in once the game kicks off.</p>'}
      ${renderMoves(fix, entries)}
    </div>
    <div class="why">
      <button type="button" class="why__toggle" data-act="fix-teams" aria-expanded="${teamsOpen ? 'true' : 'false'}">
        Pick a different team ${icon('chevron', 16)}
      </button>
      ${teamsOpen ? `<div class="why__body">${renderTeams(fix)}</div>` : ''}
    </div>`;
}

/**
 * The result, as four buttons with the recorded one pressed.
 *
 * `Pending` is the way back for a result set too early — a loss tapped at
 * half time — and hands the pick back to the automatic pass, which settles it
 * again from the final score. The note under an automatic result is there
 * for whoever is about to overrule it: it says that the overruling will hold.
 */
function renderResult(pick) {
  return `
    <div class="label">How did it go?</div>
    <div class="seg" role="group" aria-label="Result">
      ${RESULT_BUTTONS.map(([result, label]) => `
        <button type="button" class="${cx('btn', pick.result === result && 'btn--on')}" data-act="result"
                data-id="${esc(pick.id)}" data-result="${result}" data-key="${esc(pick.id)}-${result}"
                aria-pressed="${pick.result === result ? 'true' : 'false'}">${label}</button>`).join('')}
    </div>
    ${pick.resultSource === 'auto' ? '<p class="field__help">Settled from the final score. Anything you choose instead is kept.</p>' : ''}`;
}

/**
 * Giving the pick to the other entry, and clearing it.
 *
 * A refused move stays on screen, disabled, with the week that refuses it —
 * a button that silently is not there teaches nothing about why.
 */
function renderMoves(fix, entries) {
  const { pick, others } = fix;
  const nameOf = (id) => entries.find((e) => e.id === id)?.name ?? id;
  const why = (b) => (b.reason === 'out'
    ? `${nameOf(b.entry)} went out in week ${b.week}`
    : `${nameOf(b.entry)} already used ${b.team} in week ${b.week}`);

  return `
    <div class="btn-row">
      ${others.map((o) => `
        <button type="button" class="btn btn--ghost" data-act="fix-move" data-to="${esc(o.entry.id)}"
                data-key="fix-move-${esc(o.entry.id)}" ${o.blocked ? 'disabled' : ''}>
          ${icon('swap', 16)} ${esc(o.kind === 'swap' ? `Swap with ${o.entry.name}` : `Move to ${o.entry.name}`)}
        </button>`).join('')}
      <button type="button" class="btn btn--ghost" data-act="unpick" data-id="${esc(pick.id)}" data-key="fix-clear">
        ${icon('trash', 16)} Clear
      </button>
    </div>
    ${others.filter((o) => o.blocked).map((o) => `
      <p class="field__help">${esc(o.kind === 'swap' ? 'No swap' : 'No move')}: ${esc(why(o.blocked))}.
        If that is wrong, fix week ${esc(o.blocked.week)} first.</p>`).join('')}`;
}

/**
 * The board for one week, as the choice of what the pick really was.
 *
 * The Board screen's cells and states, so it reads without learning anything:
 * struck out is spent, dashed is not playing. Grouped by conference with a
 * division to a row rather than under eight headings, which is the whole
 * board in about two-thirds of the height — and at the bottom of a card
 * already open under a row, height is what there is least of.
 */
function renderTeams(fix, lead = `Week ${fix.week}'s games`) {
  const { choices, scheduleKnown, entry, week } = fix;
  const byAbbr = new Map(choices.map((c) => [c.abbr, c]));
  const conferences = new Map();
  for (const [division, teams] of byDivision()) {
    const conf = division.split(' ')[0];
    if (!conferences.has(conf)) conferences.set(conf, []);
    conferences.get(conf).push({ division, teams });
  }
  const spent = choices.some((c) => c.state === 'used');

  return `
    <p class="field__help">${esc(lead)}.${spent ? ` Struck out: teams ${esc(entry.name)} used in another week.` : ''}${scheduleKnown
      ? '' : ` Week ${esc(week)}'s schedule is not on this device, so no team shows its opponent.`}</p>
    ${[...conferences].map(([conf, divisions]) => `
      <div class="board__group">
        <h4>${esc(conf)}</h4>
        ${divisions.map(({ division, teams }) => `
          <div class="board__grid" role="group" aria-label="${esc(division)}">
            ${teams.map((t) => renderChoice(byAbbr.get(t.abbr))).join('')}
          </div>`).join('')}
      </div>`).join('')}`;
}

function renderChoice(c) {
  if (!c) return '';
  const opponent = c.game?.opponent ?? null;
  const sub = c.state === 'current' ? 'picked'
    : c.state === 'used' ? `wk ${c.usedWeek}`
      : c.state === 'bye' ? 'bye'
        : opponent ? `v ${opponent}` : '';
  const said = c.state === 'current' ? `${c.abbr}, the team recorded now`
    : c.state === 'used' ? `${c.abbr}, used in week ${c.usedWeek}`
      : c.state === 'bye' ? `${c.abbr}, not playing this week`
        : `${c.abbr}${opponent ? `, against ${opponent}` : ''}`;
  const off = c.state === 'used' || c.state === 'bye';
  return `
    <button type="button" class="${cx('board__cell', `board__cell--${c.state}`)}" data-act="fix-team"
            data-team="${esc(c.abbr)}" data-key="fix-team-${esc(c.abbr)}" aria-label="${esc(said)}"
            ${c.state === 'current' ? 'aria-pressed="true"' : ''} ${off ? 'disabled' : ''}>
      <span>${esc(c.abbr)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}
    </button>`;
}

const renderEmpty = () => `
  <div class="empty">
    ${icon('season', 28)}
    <h2>No picks yet</h2>
    <p>Take a pick on the Week screen and it will show up here, with somewhere to record how it went.</p>
  </div>`;
