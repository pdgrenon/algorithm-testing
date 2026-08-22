/**
 * Pull the two webfonts into deadpool/assets/fonts/ and write the @font-face
 * CSS that points at them.
 *
 * An authoring tool, not a build step, for the same reason measure-drives is
 * one in the sibling project: it touches the network, `dependencies` is empty,
 * and the test suite may never fetch. Run it when a font needs refreshing and
 * commit what it writes.
 *
 * Self-hosted rather than linked, and that is not a preference. `_headers`
 * ships `font-src 'self'`, so a fonts.googleapis.com link is blocked exactly as
 * hard as a third-party tracker would be — which is the point of the policy.
 * It also means the app makes no request to any other origin, ever, which is
 * the claim the whole architecture is built to be able to make.
 *
 * Only the latin subset is kept, and that is a measured decision rather than
 * laziness. Adding latin-ext costs 95.6KB — 45% of the total — to cover
 * Vietnamese and Eastern European diacritics, on a page whose entire content
 * is NFL team abbreviations, English, and numbers. Anything outside latin
 * falls back to the system stack automatically via unicode-range, which is
 * the correct outcome for a character this app was never going to draw.
 *
 * What is left is 118.7KB for two variable faces covering every weight and,
 * for Archivo, every width. The service worker precaches it once at install
 * and it is never fetched again — which is the only reason a webfont is
 * defensible here at all.
 *
 *   node scripts/fetch-fonts.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'deadpool/assets/fonts');

// A modern desktop UA, because the css2 endpoint serves woff2 only to browsers
// it believes can read it and falls back to ttf otherwise — a silent 4x weight
// increase that nothing downstream would notice.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FAMILIES = [
  {
    // The width axis is why this face and not another: 62–125% out of one
    // file gives the display voice its expanded setting and the data columns
    // their condensed one, with no second download.
    query: 'Archivo:wdth,wght@62..125,400..800',
    family: 'Archivo',
    slug: 'archivo',
  },
  {
    query: 'JetBrains+Mono:wght@400..700',
    family: 'JetBrains Mono',
    slug: 'jetbrains-mono',
  },
];

const KEEP = ['latin'];

async function get(url, asBuffer = false) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
}

/** Split Google's stylesheet into { subset, block } pairs, in source order. */
function parseFaces(css) {
  const out = [];
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
  let m;
  while ((m = re.exec(css)) !== null) out.push({ subset: m[1], block: m[2] });
  return out;
}

const field = (block, name) => (block.match(new RegExp(`${name}:\\s*([^;]+);`)) || [])[1]?.trim();

async function main() {
  await mkdir(OUT, { recursive: true });
  const rules = [];
  const manifest = [];

  for (const f of FAMILIES) {
    const css = await get(`https://fonts.googleapis.com/css2?family=${f.query}&display=swap`);
    const faces = parseFaces(css).filter((x) => KEEP.includes(x.subset));
    // Refuse a partial result rather than writing a stylesheet that silently
    // omits a face: the failure would show up as system type on one platform
    // and nowhere else.
    if (faces.length !== KEEP.length) {
      throw new Error(`${f.family}: expected ${KEEP.join('+')}, got ${faces.map((x) => x.subset).join('+') || 'nothing'}`);
    }

    for (const { subset, block } of faces) {
      const url = (block.match(/url\((https:[^)]+)\)/) || [])[1];
      if (!url) throw new Error(`${f.family}/${subset}: no woff2 url in the face`);

      const bytes = await get(url, true);
      const file = `${f.slug}-${subset}.woff2`;
      await writeFile(join(OUT, file), bytes);
      manifest.push({ family: f.family, subset, file, bytes: bytes.length, from: url });

      // font-display is deliberately dropped from Google's `swap` and set to
      // `block` below: these are self-hosted and precached by the service
      // worker, so they are already there on every load after the first. A
      // swap would flash system type for one frame on a cold load and nothing
      // else, and the numbers are tabular — a reflow mid-glance is worse than
      // 100ms of nothing.
      rules.push([
        '@font-face {',
        `  font-family: '${f.family}';`,
        '  font-style: normal;',
        `  font-weight: ${field(block, 'font-weight')};`,
        ...(field(block, 'font-stretch') ? [`  font-stretch: ${field(block, 'font-stretch')};`] : []),
        '  font-display: block;',
        `  src: url('${file}') format('woff2');`,
        `  unicode-range: ${field(block, 'unicode-range')};`,
        '}',
      ].join('\n'));
    }
  }

  const total = manifest.reduce((n, m) => n + m.bytes, 0);
  const header = [
    '/* Generated by scripts/fetch-fonts.mjs — do not hand-edit.',
    ' *',
    ' * Two variable faces, self-hosted, latin subset only.',
    ` * ${(total / 1024).toFixed(1)}KB total over ${manifest.length} files.`,
    ' *',
    ' * Archivo carries a width axis (62–125%), which is the whole reason it is',
    ' * here: the expanded setting is the display voice and the condensed one',
    ' * keeps a 32-team board in its columns, out of a single download.',
    ' *',
    ' * Licensed under the SIL Open Font License 1.1.',
    ' */',
    '',
  ].join('\n');

  await writeFile(join(OUT, 'fonts.css'), `${header}${rules.join('\n\n')}\n`);
  await writeFile(join(OUT, 'fonts.json'), `${JSON.stringify({ fetchedFrom: 'fonts.googleapis.com/css2', files: manifest }, null, 2)}\n`);

  for (const m of manifest) console.log(`  ${m.file.padEnd(30)} ${(m.bytes / 1024).toFixed(1)}KB`);
  console.log(`\n  ${manifest.length} files, ${(total / 1024).toFixed(1)}KB total → deadpool/assets/fonts/`);
}

main().catch((err) => { console.error(`fetch-fonts: ${err.message}`); process.exit(1); });
