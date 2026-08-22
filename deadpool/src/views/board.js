/**
 * The board — thirty-two teams, and what each one is to this entry.
 *
 * This is the artefact people in a survivor pool actually consult, and in the
 * terminal tool it is a JSON file with a flat list of abbreviations in it.
 *
 * Four states, because those are the four questions somebody has in front of a
 * board: have I spent this, can I take it this week, is it even playing, and
 * did it already kick off. Colour carries all four and nothing else — there
 * are no team colours here, because thirty-two brand palettes would drown the
 * four answers that matter in a field of navy and red.
 */

import { esc, cx } from '../ui/dom.js';
import { byDivision, teamShort } from '../data/teams.js';

const STATE_LABEL = { used: 'used', available: '', started: 'started', bye: 'bye' };

export function render(root, model) {
  const { entries, activeEntry, boards, statuses, week, season } = model;
  const board = boards[activeEntry] ?? [];
  const byState = board.reduce((acc, c) => { acc[c.state] = (acc[c.state] ?? 0) + 1; return acc; }, {});
  const status = statuses[activeEntry];

  root.innerHTML = `
    <section class="view">
      <div class="section-head">
        <span class="eyebrow">Board</span>
        <span class="status__week">Week ${week} · ${season}</span>
      </div>

      <div class="btn-row">
        ${entries.map((e) => `
          <button type="button" class="${cx('btn', e.id === activeEntry && 'btn--on')}"
                  data-act="entry" data-entry="${esc(e.id)}" data-key="entry-${esc(e.id)}">
            ${esc(e.name)}
          </button>`).join('')}
      </div>

      <div class="card">
        <div class="card__head">
          <h2 class="card__title">${esc(byState.available ?? 0)} still available</h2>
          <span class="${cx('chip', status.alive ? 'chip--alive' : 'chip--out')}">
            <i class="chip__dot"></i>${esc(status.alive ? status.record : 'Out')}
          </span>
        </div>
        <div class="card__body">
          <div class="board__legend">
            <span><i class="board__key board__key--available"></i>available</span>
            <span ${byState.used ? '' : 'data-zero'}><i class="board__key board__key--used"></i>used (${esc(byState.used ?? 0)})</span>
            <span ${byState.started ? '' : 'data-zero'}><i class="board__key board__key--started"></i>kicked off (${esc(byState.started ?? 0)})</span>
            <span ${byState.bye ? '' : 'data-zero'}><i class="board__key board__key--bye"></i>not playing (${esc(byState.bye ?? 0)})</span>
          </div>
          ${renderGroups(board)}
        </div>
      </div>

      ${renderSpent(board)}
    </section>`;
  return root;
}

function renderGroups(board) {
  const byAbbr = new Map(board.map((c) => [c.abbr, c]));
  const groups = byDivision();
  return [...groups.entries()].map(([name, teams]) => `
    <div class="board__group">
      <h3>${esc(name)}</h3>
      <div class="board__grid">
        ${teams.map((t) => renderCell(byAbbr.get(t.abbr))).join('')}
      </div>
    </div>`).join('');
}

function renderCell(cell) {
  if (!cell) return '';
  const label = STATE_LABEL[cell.state];
  // The week a team was spent is more useful on a cell than the word "used",
  // which the colour already says.
  const sub = cell.state === 'used' && cell.pick ? `wk ${cell.pick.week}` : label;
  const title = cell.state === 'available' && cell.game
    ? `${cell.abbr} vs ${cell.game.opponent ?? '?'}`
    : `${cell.abbr} — ${label || 'available'}`;
  return `
    <div class="${cx('board__cell', `board__cell--${cell.state}`)}" title="${esc(title)}">
      <span>${esc(cell.abbr)}</span>
      ${sub ? `<small>${esc(sub)}</small>` : (cell.game ? `<small>v ${esc(cell.game.opponent ?? '?')}</small>` : '')}
    </div>`;
}

/**
 * What has been spent, in the order it was spent.
 *
 * The grid answers "can I take this"; this answers "what have I got left to
 * work with", which is the other half of the same question and the reason
 * anybody keeps a board at all.
 */
function renderSpent(board) {
  const spent = board.filter((c) => c.state === 'used' && c.pick).sort((a, b) => a.pick.week - b.pick.week);
  if (!spent.length) return '';
  return `
    <div class="card">
      <div class="card__head"><h2 class="card__title">Spent so far</h2></div>
      <div>
        ${spent.map((c) => `
          <div class="trow trow--wide">
            <span class="trow__week">W${esc(String(c.pick.week).padStart(2, '0'))}</span>
            <span class="tcell tcell--${esc(c.pick.result)}"><span class="tcell__abbr">${esc(c.abbr)}</span>
              <span class="pick__name">${esc(teamShort(c.abbr))}</span></span>
            <span class="chip ${c.pick.result === 'win' ? 'chip--alive' : c.pick.result === 'loss' ? 'chip--out' : c.pick.result === 'tie' ? 'chip--warn' : ''}">${esc(c.pick.result)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}
