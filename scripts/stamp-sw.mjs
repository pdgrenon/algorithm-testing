/**
 * Keep the service worker's precache list and version honest.
 *
 * Two things go wrong with a hand-maintained precache list, and both are
 * invisible until somebody is offline:
 *
 *   A file ships and is not precached. The app works perfectly on every
 *   machine with a connection, and breaks only for the people who installed
 *   it — which is everybody the offline story was for.
 *
 *   A file changes and the cache name does not. The old copy is served
 *   forever, because a cache-first worker has no reason to look again.
 *
 * So the list is derived from what is actually on disk, and the version is a
 * hash of the bytes of everything in it. Change any precached file and the
 * version changes with it; add a file and it appears in the list. Neither is
 * a thing anybody has to remember.
 *
 *   node scripts/stamp-sw.mjs           write
 *   node scripts/stamp-sw.mjs --check   fail if it would change
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'deadpool');
const SW = join(SITE, 'sw.js');

/**
 * What belongs in the shell.
 *
 * `functions/` is server-side and never served; fonts.json is provenance for a
 * human; the fixtures are not shipped at all. Everything else under these
 * roots is app code and has to be there when the network is not.
 */
const ROOTS = ['src', 'assets'];
const FILES = ['/', '/index.html', '/manifest.webmanifest'];
const SKIP = new Set(['fonts.json']);
const EXT = new Set(['.js', '.css', '.woff2', '.png', '.svg', '.webmanifest', '.html']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (!SKIP.has(name) && EXT.has(name.slice(name.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

const discovered = ROOTS.flatMap((r) => walk(join(SITE, r)))
  .map((f) => `/${relative(SITE, f).split(/[\\/]/).join('/')}`)
  .sort();

const shell = [...FILES, ...discovered];

// '/' and '/index.html' are the same bytes; hash the file once.
const hash = createHash('sha256');
for (const url of shell) {
  if (url === '/') continue;
  hash.update(url);
  hash.update(readFileSync(join(SITE, url.slice(1))));
}
const version = hash.digest('hex').slice(0, 7);

const source = readFileSync(SW, 'utf8');
const next = source
  .replace(/const CACHE = '[^']*';/, `const CACHE = 'deadpool-v1-${version}';`)
  .replace(
    /const APP_SHELL = \[[\s\S]*?\n\];/,
    `const APP_SHELL = [\n${shell.map((u) => `  '${u}',`).join('\n')}\n];`,
  );

if (process.argv.includes('--check')) {
  if (next !== source) {
    const current = (source.match(/const CACHE = '([^']*)'/) ?? [])[1];
    console.error('stamp-sw --check: sw.js is out of date.');
    console.error(`  version on disk: ${current}`);
    console.error(`  version of the files: deadpool-v1-${version}`);
    console.error(`  ${shell.length} files belong in the precache list.`);
    console.error('  Run: npm run stamp');
    process.exit(1);
  }
  console.log(`stamp-sw --check: ok — ${shell.length} files, deadpool-v1-${version}`);
} else {
  writeFileSync(SW, next);
  console.log(`stamp-sw: ${shell.length} files precached, version deadpool-v1-${version}`);
}
