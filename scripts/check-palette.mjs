/**
 * Reads the palette back out of deadpool/src/css/tokens.css and re-derives it.
 *
 * This checks BOTH halves of a palette, because the first half on its own is
 * what lets a flat dark theme through. Text-on-surface is measured as a
 * contrast ratio; surface-against-surface is measured in L*, and the
 * instrument matters: a ratio between two near-blacks is a number close to 1
 * whatever their real separation, while L* is perceptually uniform by
 * construction — which is exactly the question being asked, can a person see
 * the edge of a card.
 *
 * Four assertions:
 *
 *   1. Every text token clears 4.5:1 against its *worst* surface, and the
 *      washes count as surfaces — an ink used for running text sits inside a
 *      tinted callout as often as on the card itself, and that is where this
 *      kind of audit usually fails.
 *   2. The three pairs that carry the page are separated in L*: a card
 *      against the page, an inset against its card, a raised control against
 *      the inset.
 *   3. Polarity. On dark an inset must be *lighter* than its card and on
 *      light it must be darker, because there is nothing underneath a
 *      near-black page to recede into. Getting this backwards passes every
 *      contrast assertion ever written.
 *   4. The ratio written in each comment matches the values beside it. A
 *      colour comment is a measurement, so it is checked; a stale one is
 *      worse than none, because the next person believes it.
 *
 * And one structural check: the light palette is written twice — once for the
 * un-stamped prefers-color-scheme case and once for the explicit stamp — so
 * the two copies are compared token for token. They are the likeliest thing
 * in this file to drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'deadpool/src/css/tokens.css'), 'utf8');

const AA = 4.5;          // WCAG AA for body text
const MIN_STEP = 2.5;    // L* between adjacent surfaces — the floor, not the target
const TOLERANCE = 0.15;  // how far a comment may be from the recomputed ratio

/* ------------------------------------------------------------- colour -- */

const srgb = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * srgb(r / 255) + 0.7152 * srgb(g / 255) + 0.0722 * srgb(b / 255);
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

/**
 * CIE L* from relative luminance — perceptually uniform, unlike a ratio.
 *
 * The linear branch below the knee is 903.3 * Y and not some rearrangement of
 * (29/3)^3; getting it wrong understates the darkest surfaces by about 9x,
 * which reads as a page floor sitting at 0.6 L* when it is really at 5.2 and
 * makes the bottom of the ramp look like it has room it does not have.
 */
const KNEE = (6 / 29) ** 3;
const lstar = (rgb) => {
  const y = lum(rgb);
  return y > KNEE ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
};

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

/** Returns { rgb, alpha } or null. Handles #rgb, #rrggbb and hsl(H S% L% / A). */
function parseColor(value) {
  const v = value.trim();
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), alpha: 1 };
  }
  m = v.match(/^hsla?\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*(?:\/\s*([\d.]+)\s*)?\)$/i);
  if (m) return { rgb: hslToRgb(+m[1], +m[2], +m[3]), alpha: m[4] === undefined ? 1 : +m[4] };
  return null;
}

/** Composite a translucent colour over an opaque one. */
const over = (fg, bg) => fg.rgb.map((c, i) => Math.round(c * fg.alpha + bg[i] * (1 - fg.alpha)));

/* -------------------------------------------------------------- parse -- */

/** Pull one brace-balanced block out of the stylesheet, by its selector. */
function block(startPattern) {
  const at = CSS.search(startPattern);
  if (at < 0) return null;
  const open = CSS.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') { depth -= 1; if (depth === 0) return CSS.slice(open + 1, i); }
  }
  return null;
}

/**
 * { token: { value, claim } } — `claim` is the ratio asserted in the comment.
 *
 * The ground is captured whole rather than as a single token name, because the
 * worst ground for most inks is a composite: `--brand-wash on --surface-2` is
 * one ground, not two, and a pattern that only matched `--([\w-]+)` silently
 * read no claim at all and reported every token as unmeasured.
 */
function tokens(text) {
  const out = {};
  const re = /--([\w-]+)\s*:\s*([^;]+);(?:[ \t]*\/\*\s*([\d.]+):1 on (.+?)\s*\*\/)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out[m[1]] = { value: m[2].trim(), claim: m[3] ? { ratio: +m[3], against: m[4].trim() } : null };
  }
  return out;
}

const THEMES = {
  dark: tokens(block(/^:root \{/m)),
  light: tokens(block(/^:root\[data-theme="light"\] \{/m)),
};
const LIGHT_MEDIA = tokens(block(/:root:not\(\[data-theme="dark"\]\) \{/));

const SURFACES = ['bg', 'surface', 'surface-2', 'surface-3'];
const NEUTRALS = ['ink', 'ink-2', 'ink-3'];
const STATES = ['alive', 'out', 'warn', 'brand'];
const ON_FILL = [['alive-ink', 'alive'], ['brand-ink', 'brand']];

/**
 * Which grounds a wash can actually appear over.
 *
 * Not --surface-3: that is a raised control, and a control carrying a state
 * gets the solid fill and its own --*-ink rather than a tint. Checking a wash
 * there would be refusing a combination the app never builds, which is how a
 * check like this gets too loud to keep and is deleted within a week.
 */
const WASH_GROUNDS = ['bg', 'surface', 'surface-2'];

/**
 * The ladder, as pairs with an expected direction, because the roles are not
 * a monotonic ramp and treating them as one gets the light theme backwards.
 *
 *   lift   a card rising off the page. Lighter in BOTH themes — a white card
 *          on off-white paper rises exactly as a pale card on a dark page does.
 *   inset  something set into a card. Dark: lighter, because there is nothing
 *          underneath a near-black page to recede into, so it has to catch
 *          light. Light: darker, because on paper a recess is darker.
 *
 * --surface-3 is measured against --surface rather than against --surface-2,
 * because it is a control sitting on a card and not a third step of a ramp.
 * It still has to be a distinct rung from --surface-2, which is the last pair.
 */
const LADDER = [
  ['bg', 'surface', 'lift'],
  ['surface', 'surface-2', 'inset'],
  ['surface', 'surface-3', 'inset'],
  ['surface-2', 'surface-3', 'apart'],
];

/* ------------------------------------------------------------- checks -- */

const fails = [];
const notes = [];
const worstBy = {};
const fail = (m) => fails.push(m);

for (const [theme, T] of Object.entries(THEMES)) {
  if (!T || !Object.keys(T).length) { fail(`${theme}: no token block found`); continue; }

  const solid = (name) => {
    const c = parseColor(T[name]?.value ?? '');
    return c && c.alpha === 1 ? c.rgb : null;
  };

  const plain = [];
  for (const s of SURFACES) {
    const rgb = solid(s);
    if (!rgb) { fail(`${theme}: --${s} is missing or not opaque`); continue; }
    plain.push({ name: `--${s}`, rgb });
  }

  /** Every ground this ink can actually land on, worst first. */
  const groundsFor = (ink) => {
    const g = [...plain];
    // A neutral is running text and sits inside every tinted container there
    // is; a state colour only ever sits inside its own.
    const washes = NEUTRALS.includes(ink)
      ? STATES.map((s) => `${s}-wash`)
      : [`${ink}-wash`];
    for (const w of washes) {
      const wash = parseColor(T[w]?.value ?? '');
      if (!wash) continue;
      for (const s of WASH_GROUNDS) {
        const base = solid(s);
        if (base) g.push({ name: `--${w} on --${s}`, rgb: over(wash, base) });
      }
    }
    return g;
  };

  // 1. Text against its worst ground, and 4. the comment beside it.
  for (const ink of [...NEUTRALS, ...STATES]) {
    const rgb = solid(ink);
    if (!rgb) { fail(`${theme}: --${ink} is missing or not opaque`); continue; }

    let worst = { r: Infinity, on: '' };
    for (const g of groundsFor(ink)) {
      const r = ratio(rgb, g.rgb);
      if (r < worst.r) worst = { r, on: g.name };
    }
    worstBy[`${theme}.${ink}`] = worst;

    if (worst.r < AA) fail(`${theme}: --${ink} is ${worst.r.toFixed(2)}:1 on ${worst.on} — needs ${AA}`);
    else notes.push(`${theme.padEnd(5)} --${ink.padEnd(6)} worst ${worst.r.toFixed(1)}:1  on ${worst.on}`);

    const claim = T[ink].claim;
    if (!claim) {
      fail(`${theme}: --${ink} carries no measured ratio — run with --write`);
    } else if (claim.against !== worst.on) {
      fail(`${theme}: --${ink} claims a ratio against ${claim.against}, but its worst ground is ${worst.on} — run with --write`);
    } else if (Math.abs(worst.r - claim.ratio) > TOLERANCE) {
      fail(`${theme}: --${ink} comment says ${claim.ratio}:1, actually ${worst.r.toFixed(1)}:1 — run with --write`);
    }
  }

  // Text sitting on a filled brand/state button is its own pairing.
  for (const [ink, fill] of ON_FILL) {
    const a = solid(ink); const b = solid(fill);
    if (!a || !b) { fail(`${theme}: --${ink} / --${fill} missing`); continue; }
    const r = ratio(a, b);
    if (r < AA) fail(`${theme}: --${ink} is ${r.toFixed(2)}:1 on --${fill} — needs ${AA}`);
  }

  // 2 + 3. The ladder, and which way each pair runs.
  for (const [lo, hi, kind] of LADDER) {
    const a = solid(lo); const b = solid(hi);
    if (!a || !b) continue;
    const [la, lb] = [lstar(a), lstar(b)];
    const step = Math.abs(lb - la);

    if (step < MIN_STEP) {
      fail(`${theme}: --${lo} → --${hi} is ${step.toFixed(1)} L* apart — needs ${MIN_STEP}, or the edge is invisible`);
    } else {
      notes.push(`${theme.padEnd(5)} --${lo} → --${hi}`.padEnd(32) + `${step.toFixed(1).padStart(4)} L*  (${la.toFixed(1)} → ${lb.toFixed(1)})`);
    }

    // A card rises off the page in both themes. Only an inset flips.
    const wantLighter = kind === 'lift' ? true : kind === 'inset' ? theme === 'dark' : null;
    if (wantLighter === true && lb <= la) {
      fail(`${theme}: --${hi} must be LIGHTER than --${lo}${kind === 'inset' ? ' — on a dark ground an inset catches light, it cannot recede' : ' — a card rises off the page'}`);
    }
    if (wantLighter === false && lb >= la) {
      fail(`${theme}: --${hi} must be DARKER than --${lo} — on paper a recess is darker`);
    }
  }
}

// The light palette is written twice. Compare the copies.
if (!LIGHT_MEDIA || !Object.keys(LIGHT_MEDIA).length) {
  fail('no prefers-color-scheme light block found — the un-stamped default would render dark tokens on a light OS');
} else {
  const a = LIGHT_MEDIA; const b = THEMES.light;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a)) fail(`--${k} is in the stamped light block but not the media one`);
    else if (!(k in b)) fail(`--${k} is in the media light block but not the stamped one`);
    else if (a[k].value !== b[k].value) fail(`--${k} has drifted: media says ${a[k].value}, stamped says ${b[k].value}`);
  }
}

/* -------------------------------------------------------------- write -- */

/**
 * Rewrite every measured comment from what was just computed.
 *
 * The check is not circular. This is run by a human when a token changes, the
 * result is committed, and CI still fails for anyone who edits a value without
 * re-running it — the same shape as stamping a service worker's precache list.
 * What it removes is the only way these comments have ever gone wrong, which
 * is somebody typing a plausible number.
 */
if (process.argv.includes('--write')) {
  const path = join(ROOT, 'deadpool/src/css/tokens.css');
  let text = readFileSync(path, 'utf8');
  let n = 0;

  for (const [theme, T] of Object.entries(THEMES)) {
    for (const ink of [...NEUTRALS, ...STATES]) {
      const w = worstBy[`${theme}.${ink}`];
      if (!w || !Number.isFinite(w.r)) continue;
      const value = T[ink].value;
      const note = `/* ${w.r.toFixed(1)}:1 on ${w.on} */`;
      // Anchored on the declaration so the light block's copy of a token is
      // rewritten independently of the dark one's.
      const re = new RegExp(`(--${ink}\\s*:\\s*${value.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')};)([ \\t]*/\\*[^*]*\\*/)?`, 'g');
      text = text.replace(re, (_m, decl) => { n += 1; return `${decl}   ${note}`; });
    }
  }
  writeFileSync(path, text);
  console.log(`check-palette --write: rewrote ${n} measured comments`);
  process.exit(0);
}

/* -------------------------------------------- every var() resolves -- */

/**
 * A `var(--typo)` is not an error anywhere. The browser drops the whole
 * declaration and paints nothing, so a misspelled token is a border that
 * silently does not exist -- caught only by somebody looking at the page at
 * the right width in the right theme.
 *
 * This has already happened once: `var(--line)` was written for a rule above
 * a note, where the token is `--rule`, and it passed every check in the repo.
 *
 * Only custom properties are checked, and only against what tokens.css and the
 * stylesheets themselves declare -- a local `--x` set on a rule is a
 * definition like any other.
 */
{
  const sheets = ['tokens.css', 'base.css', 'app.css'];
  const texts = sheets.map((f) => [f, readFileSync(join(ROOT, 'deadpool/src/css', f), 'utf8')]);
  const declared = new Set();
  for (const [, text] of texts) {
    // Non-capturing on the delimiter: with it capturing, `[, name]` took the
    // delimiter rather than the token and `declared` filled with semicolons.
    for (const [, name] of text.matchAll(/(?:^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g)) declared.add(name);
  }
  for (const [file, text] of texts) {
    for (const m of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*(,|\))/g)) {
      // A var() with a fallback still paints, so it is not the silent case.
      if (m[2] === ',') continue;
      if (!declared.has(m[1])) fails.push(`${file}: var(${m[1]}) is used but never declared`);
    }
  }
}

/* ------------------------------------------------------------- report -- */

if (process.argv.includes('--verbose')) notes.forEach((n) => console.log(`  ${n}`));

if (fails.length) {
  console.error(`\ncheck-palette: ${fails.length} problem${fails.length === 1 ? '' : 's'}\n`);
  fails.forEach((f) => console.error(`  ✗ ${f}`));
  console.error('');
  process.exit(1);
}
console.log(`check-palette: ok — ${Object.keys(THEMES.dark).length} tokens, both themes, ladder and comments verified`);
