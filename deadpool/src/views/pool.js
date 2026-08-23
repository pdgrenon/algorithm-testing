/**
 * The pool — who is left, and what they have already spent.
 *
 * The other three screens are about your two entries. This one is about the
 * other 248, and it is the only screen in the app drawing something that was
 * *observed* rather than modelled.
 *
 * ── What it leads with, and why that and not popularity ─────────────────
 *
 * Scarcity, not chalk. The headline table is "how many survivors can still
 * take this team", ascending — because that number is exact, and because it
 * is the one that decides a late week. A survivor pool's endgame is not about
 * who is good; by Week 13 everybody agrees who is good and most of the field
 * has already spent them. It is about who is *left to you* that is not left to
 * them, and that is arithmetic over the inventories on this page.
 *
 * Popularity is below it and framed more carefully, because it is a weaker
 * thing: it is always about weeks that have already happened. You cannot see
 * this week's picks before deciding — that is the structure of the game, not a
 * limitation of the sheet — so nothing here is a forecast and the page never
 * phrases it as one.
 *
 * ── The empty state is most of this file's job ──────────────────────────
 *
 * Nearly every deployment has no sheet configured, and the ones that do have
 * nothing to show until Week 1 has kicked off. Four distinct nothings, each
 * with its own sentence, because "no sheet is set" and "the sheet would not
 * open" and "the sheet is fine and the season has not started" want completely
 * different actions from whoever is reading.
 */

import { esc, cx } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { teamShort } from '../data/teams.js';

export function render(root, model) {
  const { field, describe, abbrs, problems } = model;

  root.innerHTML = `
    <section class="view">
      <div class="section-head">
        <span class="eyebrow">Pool</span>
      </div>

      ${field.observed ? renderAlive(field) : ''}
      ${field.observed ? renderScarcity(field, abbrs) : renderEmpty(field, describe)}
      ${field.observed ? renderPopularity(field) : ''}
      ${renderProblems(problems)}
      ${renderProvenance(describe)}
    </section>`;
  return root;
}

/* ------------------------------------------------------------- headline -- */

function renderAlive(field) {
  const out = field.total - field.alive;
  return `
    <div class="card">
      <div class="card__head">
        <h2 class="card__title">${esc(field.alive)} still alive</h2>
        <span class="chip chip--alive"><i class="chip__dot"></i>of ${esc(field.total)}</span>
      </div>
      <div class="card__body">
        <div class="bar"><i class="bar__fill" data-fill="${esc(field.total ? field.alive / field.total : 0)}"></i></div>
        <p class="note">
          ${esc(out)} ${out === 1 ? 'entry has' : 'entries have'} been eliminated through
          week ${esc(field.latestWeek ?? '—')}. Everything on this page is read from the
          pool's own sheet, so it is what happened rather than what a model expects.
        </p>
      </div>
    </div>`;
}

/* ------------------------------------------------------------ scarcity -- */

/**
 * How many survivors can still take each team.
 *
 * Ascending, so the scarce end is at the top: those are the teams that are
 * effectively yours if you still hold them, because almost nobody else can
 * follow you onto one. A team every survivor still has is worth nothing as a
 * differentiator however good it is, which is the point the ordering makes
 * without a sentence.
 *
 * Only teams somebody has spent are listed. A team no survivor has touched is
 * available to all of them, carries no information, and would be 20-odd rows
 * of identical bars pushing the useful end off the screen.
 */
function renderScarcity(field, abbrs) {
  const names = Object.keys(field.inventories);
  if (!names.length) return '';

  const counts = new Map();
  for (const name of names) {
    for (const team of field.inventories[name]) counts.set(team, (counts.get(team) ?? 0) + 1);
  }
  if (!counts.size) return '';

  const rows = [...counts.entries()]
    .map(([team, spent]) => ({ team, spent, left: names.length - spent }))
    .sort((a, b) => a.left - b.left || (a.team < b.team ? -1 : 1));

  return `
    <div class="card">
      <div class="card__head">
        <h2 class="card__title">Who is left to take whom</h2>
        <span class="chip">${esc(rows.length)} of ${esc(abbrs.length)} spent</span>
      </div>
      <div class="card__body">
        <p class="note">
          Of the ${esc(names.length)} surviving ${names.length === 1 ? 'entry' : 'entries'},
          how many could still pick each team. Exact — this is what the sheet says
          they have spent, not an estimate of what they will do.
        </p>
        ${rows.map((r) => renderScarcityRow(r, names.length)).join('')}
      </div>
    </div>`;
}

function renderScarcityRow({ team, left }, survivors) {
  const share = survivors ? left / survivors : 0;
  // Amber below a third, because that is where a team stops being a pick the
  // field can follow you onto and starts being leverage.
  const scarce = share <= 0.34;
  return `
    <div class="prow">
      <span class="prow__abbr">${esc(team)}</span>
      <span class="prow__name">${esc(teamShort(team))}</span>
      <span class="${cx('bar', 'bar--slim', scarce && 'bar--est')}">
        <i class="bar__fill" data-fill="${esc(share)}"></i>
      </span>
      <span class="${cx('prow__num', scarce && 'prow__num--warn')}">${esc(left)}</span>
    </div>`;
}

/* ---------------------------------------------------------- popularity -- */

/**
 * What the field did, week by week.
 *
 * Past tense everywhere in this block, deliberately and repeatedly. The single
 * most expensive misreading available on this page is treating a column of
 * observed shares as a prediction of the column that has not happened yet.
 */
function renderPopularity(field) {
  const weeks = Object.keys(field.popularity).map(Number).sort((a, b) => b - a);
  if (!weeks.length) return '';

  return `
    <div class="card">
      <div class="card__head"><h2 class="card__title">What the field took</h2></div>
      <div class="card__body">
        <p class="note">
          Observed, and only ever for weeks that have already kicked off — a pool
          never shows you the current week in time to use it. What this is good for
          is knowing how chalky <em>this</em> pool runs, rather than borrowing an
          average from pools full of other people.
        </p>
        ${weeks.map((w) => renderPopularityWeek(w, field.popularity[w])).join('')}
      </div>
    </div>`;
}

function renderPopularityWeek(week, shares) {
  const top = Object.entries(shares).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!top.length) return '';
  return `
    <div class="pweek">
      <h3 class="pweek__head">Week ${esc(week)}</h3>
      ${top.map(([team, share]) => `
        <div class="prow">
          <span class="prow__abbr">${esc(team)}</span>
          <span class="prow__name">${esc(teamShort(team))}</span>
          <span class="bar bar--slim"><i class="bar__fill" data-fill="${esc(share)}"></i></span>
          <span class="prow__num">${esc((share * 100).toFixed(0))}%</span>
        </div>`).join('')}
    </div>`;
}

/* --------------------------------------------------------------- empty -- */

/**
 * The four nothings, told apart.
 *
 * Each one wants a different action from whoever is reading it, and a single
 * "no data" would hide which of the four this is — including the one case that
 * looks identical to working and is not: a sheet nobody shared answers 200
 * with a sign-in page, which parses to an empty pool.
 */
function renderEmpty(field, describe) {
  const body = field.configured === false
    ? `This deployment has not been given a pool sheet. Set <code>POOL_SHEET_URL</code>
       in the Pages environment — either the whole CSV-export link or just the
       spreadsheet id — and this screen fills itself in.`
    : describe.tone === 'offline' && field.configured
      ? `A sheet is configured and did not come back. Nothing is wrong with your
         picks; this screen is the only thing that needs it.`
      : `The sheet is readable and has no picks in it yet. Entries become visible
         after kickoff each week, so this stays empty until Week 1 has been played.`;

  return `
    <div class="card">
      <div class="card__head"><h2 class="card__title">Nothing to read yet</h2></div>
      <div class="card__body">
        <p class="note">${body}</p>
        <div class="btn-row">
          <button type="button" class="btn" data-act="refresh" data-key="pool-refresh">
            ${icon('swap', 16)} Try again
          </button>
        </div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------- provenance -- */

/**
 * How old this is, in the same words and the same dot as every other screen.
 *
 * At the foot rather than the head, which is the opposite of where it sits on
 * the Week screen and is deliberate: there, freshness decides whether you can
 * trust a number you are about to act on within the hour. Here the content is
 * a record of weeks already played, and a sheet read on Monday is still exactly
 * right on Saturday — so this is a footnote rather than a warning.
 */
function renderProvenance(describe) {
  return `
    <div class="meta">
      <span class="${cx('meta__dot', describe.tone === 'cache' && 'meta__dot--cache', describe.tone === 'offline' && 'meta__dot--offline')}"></span>
      <span>${esc(describe.text)}</span>
    </div>`;
}

/* ------------------------------------------------------------ problems -- */

/**
 * What the parser could not make sense of.
 *
 * Shown rather than swallowed, and shown even when the rest of the page
 * worked. A sheet that parsed 249 rows and choked on one is a sheet with one
 * entry silently missing from every count above it.
 */
function renderProblems(problems) {
  if (!problems?.length) return '';
  return `
    <div class="warn">
      ${icon('alert', 18)}
      <div>
        <strong>${esc(problems.length)} thing${problems.length === 1 ? '' : 's'} in the sheet did not read.</strong>
        Everything above is computed without ${problems.length === 1 ? 'that row' : 'those rows'},
        so the counts are of what parsed rather than of the whole sheet.
        <ul class="plist">
          ${problems.map((p) => `<li>${esc(p)}</li>`).join('')}
        </ul>
      </div>
    </div>`;
}
