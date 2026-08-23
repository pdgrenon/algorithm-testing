/**
 * Render the app icons from the mark.
 *
 * The mark is defined once, in src/ui/icons.js, and drawn inline in the app.
 * Everything a launcher needs is a raster, so this rasterises the same
 * geometry through Chromium rather than keeping a second copy of it in a
 * drawing file that would drift.
 *
 * The maskable variant is a different composition, not the same one padded by
 * a different number: Android crops a maskable icon to whatever shape the
 * launcher uses, and the safe zone is the middle 80%. Anything drawn to the
 * edge of a plain icon loses its corners there.
 *
 *   node scripts/make-icons.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { markGeometry } from '../deadpool/src/ui/icons.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'deadpool/assets');

// --bg and --brand from tokens.css, in the dark theme, which is the app's
// default and the ground the mark was drawn against.
const GROUND = '#0d1216';
const BRAND = '#ddcda6';
const ALIVE = '#4ac9a0';

/**
 * The mark, coloured for a launcher.
 *
 * The geometry comes from src/ui/icons.js rather than being written out again
 * here. It *was* written out again here -- same coordinates, three different
 * opacities -- under a docstring at the top of this file saying the mark is
 * defined once so that a second copy cannot drift. It had already drifted.
 *
 * What stays local is the presentation, and deliberately: the lit cell is jade
 * rather than bone here and only here, because at 48px on a home screen "one
 * square still alive" is the whole point and has to survive; and the frame,
 * cells and strikes carry a little more weight than they do beside a wordmark.
 */
const markSvg = () => markGeometry({
  ink: BRAND,
  lit: ALIVE,
  frame: 0.4,
  cell: 0.24,
  strike: 0.62,
});

/** `inset` is how much of the canvas the mark leaves clear, as a fraction. */
const iconSvg = ({ size, inset, rounded }) => {
  const box = size * (1 - inset * 2);
  const scale = box / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" ${rounded ? `rx="${size * 0.22}"` : ''} fill="${GROUND}"/>
  <g transform="translate(${size * inset}, ${size * inset}) scale(${scale})">${markSvg()}</g>
</svg>`;
};

const TARGETS = [
  // A plain icon can use most of its canvas; the launcher shows it as drawn.
  { file: 'icon-192.png', size: 192, inset: 0.14, rounded: false },
  { file: 'icon-512.png', size: 512, inset: 0.14, rounded: false },
  // Maskable: everything inside the middle 80%, because the corners are gone.
  { file: 'icon-maskable-512.png', size: 512, inset: 0.22, rounded: false },
  // iOS applies its own rounding and never a mask, so this one is drawn square
  // and generously inset — the system squircle eats the corners either way.
  { file: 'apple-touch-icon.png', size: 180, inset: 0.16, rounded: false },
];

async function main() {
  mkdirSync(OUT, { recursive: true });

  // The favicon is SVG so it stays sharp and needs no raster at all. img-src
  // covers it as a file on this origin; a data: URI would need an exception.
  writeFileSync(join(OUT, 'favicon.svg'), `${iconSvg({ size: 64, inset: 0.1, rounded: true })}\n`);

  const browser = await chromium.launch();
  try {
    for (const t of TARGETS) {
      const page = await browser.newPage({ viewport: { width: t.size, height: t.size }, deviceScaleFactor: 1 });
      await page.setContent(
        `<!doctype html><style>html,body{margin:0;padding:0;background:${GROUND}}</style>${iconSvg(t)}`,
        { waitUntil: 'load' },
      );
      await page.screenshot({ path: join(OUT, t.file), omitBackground: false });
      await page.close();
      console.log(`  ${t.file.padEnd(26)} ${t.size}×${t.size}`);
    }
  } finally {
    await browser.close();
  }
  console.log('  favicon.svg                vector');
}

main().catch((err) => { console.error(`make-icons: ${err.message}`); process.exit(1); });
