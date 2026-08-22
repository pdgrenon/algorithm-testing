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
};

const shots = [];

async function shoot(page, name, note) {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(350);
  const size = page.viewportSize();
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  shots.push({ name, note, width: size.width, height: size.height });
  console.log(`  ${name.padEnd(26)} ${size.width}×${size.height}  ${note}`);
}

async function openApp(browser, viewport, theme, seed = true) {
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
    }, SEED);
  }
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  page._problems = problems;
  return page;
}

const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(300); };

async function main() {
  const browser = await chromium.launch();
  const problems = [];
  try {
    // Phone, dark — the app's own default and the way it will actually be used.
    let page = await openApp(browser, PHONE, 'dark');
    await shoot(page, 'phone-dark-week', 'the answer, above the fold');
    await go(page, '#/board');
    await shoot(page, 'phone-dark-board', 'thirty-two teams, four states');
    await go(page, '#/season');
    await shoot(page, 'phone-dark-season', 'every week, and results to record');
    await go(page, '#/settings');
    await shoot(page, 'phone-dark-settings', 'strategy controls generated from the registry');
    await page.evaluate(() => window.scrollTo(0, 900));
    await shoot(page, 'phone-dark-settings-2', 'parameters and the comparison table');
    problems.push(...page._problems.map((p) => `phone-dark: ${p}`));
    await page.close();

    // Phone, light — a full second palette rather than a filter.
    page = await openApp(browser, PHONE, 'light');
    await shoot(page, 'phone-light-week', 'the light theme, solved separately');
    await go(page, '#/board');
    await shoot(page, 'phone-light-board', 'the board on light');
    problems.push(...page._problems.map((p) => `phone-light: ${p}`));
    await page.close();

    // The open why-panel, which is the app's answer to "why this team".
    page = await openApp(browser, PHONE, 'dark');
    await page.locator('details.why').first().click();
    await shoot(page, 'phone-dark-why', 'the structured why panel');
    problems.push(...page._problems.map((p) => `phone-why: ${p}`));
    await page.close();

    // Desktop, so the layout is checked somewhere other than a phone.
    page = await openApp(browser, DESK, 'dark');
    await shoot(page, 'desktop-dark-week', 'wide, where the column is capped');
    problems.push(...page._problems.map((p) => `desktop: ${p}`));
    await page.close();

    // Nothing stored, nothing cached — the state a stranger opens.
    page = await openApp(browser, PHONE, 'dark', false);
    await shoot(page, 'phone-dark-fresh', 'a first run, no history');
    problems.push(...page._problems.map((p) => `fresh: ${p}`));
    await page.close();
  } finally {
    await browser.close();
  }

  if (problems.length) {
    console.error(`\n${problems.length} console error(s) while shooting:`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log(`\n  ${shots.length} shots → shots/`);
}

main().catch((err) => { console.error(`shots: ${err.message}`); process.exit(1); });
