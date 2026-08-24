/**
 * Photograph the app.
 *
 * Nothing in the test suite draws the page. The static checks and the parity
 * suite cover what can be checked without a DOM, and that is not the same as
 * the page being right — every visual fault in a project like this is
 * invisible in the diff and obvious in a picture.
 *
 * Runs against the fixture server, so the board is deterministic: re-running
 * this produces the same screens, and a difference means something changed.
 *
 *   node scripts/dev.mjs --fixtures &
 *   node scripts/shots.mjs
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'shots');
const BASE = process.env.BASE ?? 'http://localhost:8787';

/**
 * Where Chromium is, when it is not where Playwright expects.
 *
 * Playwright resolves a browser by the build number its own version pins, so a
 * machine with a perfectly good Chromium installed under a different build --
 * a CI image, a container that pre-installs one -- fails with "Executable
 * doesn't exist" and a suggestion to download another copy. `CHROME_PATH`
 * skips that: point it at the binary and this runs against what is already
 * there. Unset locally, where `npx playwright install` has done its job.
 */
const CHROME_PATH = process.env.CHROME_PATH || undefined;

const PHONE = { width: 412, height: 900 };
const DESK = { width: 1280, height: 900 };

/**
 * Two weeks already played, so the board and the season have something on
 * them. Week 3 is left open, which is the state the Week screen is designed
 * around — and Entry B is carrying a loss, so the eliminated path is on
 * screen rather than only in a test.
 */
const SEED = {
  state: {
    schema: 1,
    entries: [{ id: 'A', name: 'Entry A' }, { id: 'B', name: 'Entry B' }],
    season: 2026, strikesAllowed: 1, tieIsLoss: true,
    strategyId: 'joint', params: {}, theme: 'system',
  },
  picks: [
    { id: '2026-01-A', entry: 'A', season: 2026, week: 1, team: 'MIN', opponent: 'TB', result: 'win', strategyId: 'joint', snapshot: { winPct: 93.9, source: 'api' } },
    { id: '2026-01-B', entry: 'B', season: 2026, week: 1, team: 'SF', opponent: 'CHI', result: 'win', strategyId: 'joint', snapshot: { winPct: 93.2, source: 'api' } },
    { id: '2026-02-A', entry: 'A', season: 2026, week: 2, team: 'BAL', opponent: 'NYG', result: 'win', strategyId: 'joint', snapshot: { winPct: 88.1, source: 'api' } },
    { id: '2026-02-B', entry: 'B', season: 2026, week: 2, team: 'DET', opponent: 'CAR', result: 'win', strategyId: 'joint', snapshot: { winPct: 86.4, source: 'api' } },
  ],
  /**
   * A pool sheet, seeded through the cache rather than served.
   *
   * The Pool screen needs a field to draw anything, and the fixture server has
   * no sheet: /api/pool answers `configured: false` there, because it is the
   * real handler in both modes and there is no POOL_SHEET_URL. Photographing
   * only that would photograph the empty state — which is worth having, and is
   * not the state where the interesting drawing happens.
   *
   * So the cached payload goes in directly, which is a real path rather than a
   * back door: `loadPool` is cache-first and this is exactly the shape it
   * writes. The live fetch then answers `configured: false` behind it, which
   * is *also* the case worth covering — a good cached sheet must survive an
   * endpoint that has stopped answering, and it did not until this run caught
   * it.
   *
   * Twelve of the twenty spent KC, so the scarcity table has a top row that
   * means something and the amber threshold is on screen.
   */
  pool: {
    configured: true,
    ok: true,
    fetchedAt: '2026-09-29T12:00:00.000Z',
    entries: 20,
    alive: 15,
    weeks: [1, 2, 3],
    problems: [],
    popularity: {
      1: { KC: 0.6, BUF: 0.25, PHI: 0.15 },
      2: { BAL: 0.4, SF: 0.35, MIN: 0.25 },
      3: { DET: 0.35, LAC: 0.35, GB: 0.3 },
    },
    inventories: Object.fromEntries(
      ['Gridiron Gang', 'Ship of Theseus', 'Last Man Standing', 'Fourth and Long',
        'The Chalk Eaters', 'Hail Mary Inc', 'Survivor Bias', 'Punt Returns',
        'Double Doink', 'Victory Formation', 'Bye Week Blues', 'Coin Flip Club',
        'Zero Sum Sunday', 'Red Zone Refugees', 'Prevent Defense']
        .map((name, i) => [name, [
          i < 12 ? 'KC' : 'BUF',
          ['BAL', 'SF', 'MIN'][i % 3],
          ['DET', 'LAC', 'GB'][i % 3],
        ]]),
    ),
    latestWeek: 3,
  },
};

const shots = [];

/**
 * Geometry that has to be true on every view, checked in the browser.
 *
 * This is the whole reason the browser job exists and it was not being done.
 * `shoot` recorded `page.viewportSize()` — a constant, not any element's box —
 * so the only thing that could fail this script was a console error. CLAUDE.md
 * makes this the repository's visual gate *because of* the `.bar__fill` fault:
 * an `<i>` with `width: 75%` on it drew 0×0 while 268 tests passed. A gate
 * that cannot see the fault it was built for is not a gate.
 *
 * Two invariants, both cheap and both aimed at that class of fault:
 *
 *   1. A bar fill with a non-zero `data-fill` must have a non-zero box. This
 *      is the original fault, stated directly.
 *   2. Nothing inside #view that renders visible text may have a 0×0 box. That
 *      catches the general shape of it — an element styled as though it were a
 *      block when the browser is treating it as inline.
 *
 * Deliberately not a pixel comparison: a screenshot diff over a stylesheet
 * this alive fails on every legitimate change and gets switched off.
 */
async function geometryProblems(page, name) {
  return (await page.evaluate(() => {
    const found = [];
    const box = (el) => el.getBoundingClientRect();

    for (const el of document.querySelectorAll('.bar__fill')) {
      const fill = Number(el.dataset.fill);
      if (!Number.isFinite(fill) || fill <= 0) continue;
      const r = box(el);
      if (r.width <= 0 || r.height <= 0) {
        found.push(`.bar__fill[data-fill="${el.dataset.fill}"] is ${r.width}×${r.height}`);
      }
    }

    const view = document.getElementById('view');
    for (const el of view ? view.querySelectorAll('*') : []) {
      // Only leaves with their own visible text — a wrapper legitimately
      // collapses, and an ancestor would report its child's text as its own.
      if (el.children.length) continue;
      if (!(el.textContent || '').trim()) continue;
      // A closed <select> gives its options no box at all, and a collapsed
      // <details> does the same for its body. Both are the browser drawing a
      // control correctly, not a layout fault.
      if (el.closest('select, optgroup')) continue;
      if (el.closest('details:not([open])')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = box(el);
      if (r.width <= 0 || r.height <= 0) {
        found.push(`<${el.tagName.toLowerCase()} class="${el.className}"> has text but is ${r.width}×${r.height}`);
      }
    }
    return found;
  })).map((p) => `${name}: ${p}`);
}

async function shoot(page, name, note) {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(350);
  const size = page.viewportSize();
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  const bad = await geometryProblems(page, name);
  shots.push({ name, note, width: size.width, height: size.height });
  console.log(`  ${name.padEnd(26)} ${size.width}×${size.height}  ${note}${bad.length ? `  ✗ ${bad.length} geometry` : ''}`);
  return bad;
}

/**
 * The same seed with the win-probability model's two corrections switched on.
 *
 * Worth its own pass rather than folding into SEED. Off is the shipped state
 * and has to be the one most screens are photographed in -- but off means the
 * divergence and bias cells legitimately do not draw, so photographing only
 * that would leave the new rendering path unphotographed, which is the exact
 * gap this script exists to close.
 */
const SEED_MODEL_ON = {
  ...SEED,
  state: {
    ...SEED.state,
    // The app's own default strategy rather than the one the other shots use.
    // `joint` declares a single parameter and no lookahead, so photographing
    // the advanced panel through it would leave the lookahead slider -- the
    // control most likely to be reached for -- unphotographed.
    strategyId: 'distinct',
    model: { marketWeight: 50, teamBias: true },
  },
};

async function openApp(browser, viewport, theme, seed = true, seedData = SEED) {
  const page = await browser.newPage({
    viewport,
    colorScheme: theme === 'light' ? 'light' : 'dark',
    deviceScaleFactor: 2,
  });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e.message)));

  if (seed) {
    await page.addInitScript((s) => {
      localStorage.setItem('deadpool.state.v1', JSON.stringify(s.state));
      localStorage.setItem('deadpool.picks.v1', JSON.stringify(s.picks));
      // The cache keyspace, exactly as store/index.js writes it.
      localStorage.setItem('deadpool.cache.v1.pool.2026', JSON.stringify({ ...s.pool, cachedAt: s.pool.fetchedAt }));
    }, seedData);
  }
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  page._problems = problems;
  return page;
}

const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(300); };

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME_PATH });
  const problems = [];
  try {
    // Phone, dark — the app's own default and the way it will actually be used.
    let page = await openApp(browser, PHONE, 'dark');
    problems.push(...await shoot(page, 'phone-dark-week', 'the answer, above the fold'));
    await go(page, '#/board');
    problems.push(...await shoot(page, 'phone-dark-board', 'thirty-two teams, four states'));
    await go(page, '#/season');
    problems.push(...await shoot(page, 'phone-dark-season', 'every week, and results to record'));
    await go(page, '#/pool');
    problems.push(...await shoot(page, 'phone-dark-pool', 'the field: who is left to take whom'));
    await page.evaluate(() => window.scrollTo(0, 1400));
    problems.push(...await shoot(page, 'phone-dark-pool-2', 'what the field took, week by week'));
    await page.evaluate(() => window.scrollTo(0, 0));
    await go(page, '#/settings');
    problems.push(...await shoot(page, 'phone-dark-settings', 'strategy controls generated from the registry'));
    await page.evaluate(() => window.scrollTo(0, 900));
    problems.push(...await shoot(page, 'phone-dark-settings-2', 'parameters and the comparison table'));
    problems.push(...page._problems.map((p) => `phone-dark: ${p}`));
    await page.close();

    // Phone, light — a full second palette rather than a filter.
    page = await openApp(browser, PHONE, 'light');
    problems.push(...await shoot(page, 'phone-light-week', 'the light theme, solved separately'));
    await go(page, '#/board');
    problems.push(...await shoot(page, 'phone-light-board', 'the board on light'));
    await go(page, '#/pool');
    problems.push(...await shoot(page, 'phone-light-pool', 'the scarcity bars on light'));
    problems.push(...page._problems.map((p) => `phone-light: ${p}`));
    await page.close();

    // The open why-panel, which is the app's answer to "why this team".
    page = await openApp(browser, PHONE, 'dark');
    await page.locator('details.why').first().click();
    problems.push(...await shoot(page, 'phone-dark-why', 'the structured why panel'));
    problems.push(...page._problems.map((p) => `phone-why: ${p}`));
    await page.close();

    // The model's working, with both corrections on so all three cells draw.
    // The Elo blend and the team bias are off by default, so the default
    // screens above show the model line alone -- which is correct, and is not
    // a photograph of the code added for them.
    page = await openApp(browser, PHONE, 'dark', true, SEED_MODEL_ON);
    problems.push(...await shoot(page, 'phone-dark-week-model', 'line, nfelo divergence and bias, all on'));
    await go(page, '#/settings');
    await page.locator('details#advanced').first().click();
    await page.locator('details#advanced').first().scrollIntoViewIfNeeded();
    problems.push(...await shoot(page, 'phone-dark-settings-model', 'the two model controls, open'));
    problems.push(...page._problems.map((p) => `phone-model: ${p}`));
    await page.close();

    // Desktop, so the layout is checked somewhere other than a phone.
    page = await openApp(browser, DESK, 'dark');
    problems.push(...await shoot(page, 'desktop-dark-week', 'wide, where the column is capped'));
    problems.push(...page._problems.map((p) => `desktop: ${p}`));
    await page.close();

    // Nothing stored, nothing cached — the state a stranger opens.
    page = await openApp(browser, PHONE, 'dark', false);
    problems.push(...await shoot(page, 'phone-dark-fresh', 'a first run, no history'));
    problems.push(...page._problems.map((p) => `fresh: ${p}`));
    await page.close();
  } finally {
    await browser.close();
  }

  if (problems.length) {
    console.error(`\n${problems.length} problem(s) while shooting — console errors and geometry:`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(`\n  ${shots.length} shots → shots/`);
}

main().catch((err) => { console.error(`shots: ${err.message}`); process.exit(1); });
