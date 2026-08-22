/**
 * The season — every week, both entries, and where a result still has to go in.
 *
 * This screen exists because of the single largest gap in the tool it wraps:
 * survivor-picker stores a flat list of used teams with no week and no
 * outcome, so it cannot say whether you are still in the pool. Recording a
 * result is one tap here, and everything else in the app — alive or out,
 * strikes, the record, the board — is derived from what is entered on this
 * page.
 *
 * Pending picks are pulled to the top rather than left in date order, because
 * the reason somebody opens this screen on a Monday is to clear them.
 */

import { esc, cx } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

const RESULT_CHIP = { win: 'chip--alive', loss: 'chip--out', tie: 'chip--warn', pending: '' };

export function render(root, model) {
  const { entries, timeline, statuses, season } = model;
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

      ${timeline.length ? `
        <div class="card">
          <div class="card__head">
            <h2 class="card__title">Every week</h2>
            <span class="label">${esc(entries.map((e) => e.name).join(' · '))}</span>
          </div>
          <div>${timeline.map((row) => renderRow(row, entries)).join('')}</div>
        </div>` : renderEmpty()}
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

function renderRow(row, entries) {
  return `
    <div class="trow">
      <span class="trow__week">W${esc(String(row.week).padStart(2, '0'))}</span>
      ${entries.map((e) => {
        const cell = row.cells.find((c) => c.entry === e.id);
        if (!cell || !cell.pick) return `<span class="tcell tcell--empty">—</span>`;
        const p = cell.pick;
        return `
          <button type="button" class="${cx('tcell', `tcell--${p.result}`)}" data-act="cycle"
                  data-id="${esc(p.id)}" data-key="${esc(p.id)}" title="Tap to change the result">
            <span class="tcell__abbr">${esc(p.team)}</span>
            <span class="chip ${RESULT_CHIP[p.result]}">${esc(p.result === 'pending' ? '?' : p.result)}</span>
          </button>`;
      }).join('')}
    </div>`;
}

const renderEmpty = () => `
  <div class="empty">
    ${icon('season', 28)}
    <h2>No picks yet</h2>
    <p>Take a pick on the Week screen and it will show up here, with somewhere to record how it went.</p>
  </div>`;
