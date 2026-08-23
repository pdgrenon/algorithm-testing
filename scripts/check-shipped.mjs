/**
 * Static checks on the code that actually reaches a browser.
 *
 * Nothing in the test suite draws the page — there is no DOM in `node --test`
 * — so src/app.js and the views are the largest unexecuted files here. What
 * follows is what can be checked without a browser, and every one of these
 * assertions exists because the equivalent mistake was made in this codebase
 * or in a sibling and shipped:
 *
 *   1. No inline style attributes. The app ships style-src 'self' with no
 *      'unsafe-inline', so a style="" written into a rendered string is
 *      refused by the browser — silently, as far as the page is concerned.
 *      Four of them shipped in the first draft of the views and were only
 *      found by opening the console. Read over the *markup* — see `scan`
 *      below for why this and check 5 could not fail at all until they were.
 *   2. Every data-act has a handler. A button wired to an action nobody
 *      implemented looks perfect and does nothing.
 *   3. Every data-bind has a branch, for the same reason.
 *   4. Every identifier a view calls is declared, imported or a browser
 *      global. The sibling project shipped a page that threw ReferenceError
 *      on two screens because a helper only existed in another renderer.
 *   5. Nothing reaches a third-party origin. connect-src 'self' would refuse
 *      it anyway; this catches it before the browser has to.
 *   6. The manifest's icons exist.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'deadpool');
const problems = [];
const fail = (m) => problems.push(m);

const walk = (dir, out = []) => {
  for (const n of readdirSync(dir).sort()) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (n.endsWith('.js')) out.push(f);
  }
  return out;
};

const SRC = walk(join(SITE, 'src'));
const rel = (f) => relative(ROOT, f);

/**
 * Split a module into the two halves the checks below need.
 *
 * A regular expression cannot do this, and the first version of this file
 * proved it by reporting fifteen problems that were all prose: `used (${n})`
 * inside a template literal looks exactly like a call to `used()`, and a
 * regex containing a quote character opens a string state that swallows the
 * rest of the file.
 *
 * So this is a small scanner. It tracks comments, both quote styles, template
 * literals — keeping the code inside `${...}`, which is where real calls live
 * — and regular expressions, which are told from division by what precedes
 * them. Blanked spans become spaces rather than being removed, so a reported
 * line number is still the line in the file.
 *
 * ── Why two halves and not one ──────────────────────────────────────────
 *
 * It returned only `code`, and every check ran on that. Two of them wanted the
 * opposite and were therefore **dead**: an inline `style=""` and a
 * third-party URL are both written *inside* a string or a template literal,
 * which is exactly what `code` blanks. Both checks passed on anything.
 * Verified by planting each: a `style="color: red"` in a view, an
 * `https://evil.example.com/px.gif` in another, and this script printing ok.
 *
 * So the scanner now also returns `text` — the contents of every string and
 * template literal, and nothing else. Comments are in neither, which is the
 * point: several modules cite a github.com URL in prose and must not fail the
 * origin check for it.
 */
function scan(src) {
  const out = Array.from(src);
  // The inverse view: spaces everywhere except inside a literal.
  const txt = Array.from(src, (c) => (c === '\n' ? c : ' '));
  const blank = (from, to) => { for (let i = from; i < to && i < out.length; i += 1) if (out[i] !== '\n') out[i] = ' '; };
  /** Move a span from the code view into the text view. */
  const literal = (from, to) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] === '\n') continue;
      txt[i] = src[i];
      out[i] = ' ';
    }
  };

  // ` and ${ nest, so the template state is a stack rather than a flag.
  const stack = [];
  let i = 0;
  let lastSignificant = '';

  // Where a `/` may begin a regex literal rather than a division.
  //
  // Stated as what it may *not* follow, which is the safe direction for a
  // scanner that blanks what it matches: a division misread as a regex eats
  // everything up to the next `/` on the line, and every check below then runs
  // over a span with a hole in it. This read `/[a-z]/.test(c) === false`, which
  // is true after `)`, `]` and a digit -- so `(x + y) / 2 + (z) / 3` lost the
  // middle of itself. Nothing in the tree happens to be written that way today,
  // which is exactly the kind of thing that stops being true quietly.
  const regexCanStart = () => !/[\w$)\]}]/.test(lastSignificant);

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    const inTemplate = stack.length && stack[stack.length - 1] === 'template';

    if (inTemplate) {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { stack.pop(); out[i] = ' '; i += 1; continue; }
      if (c === '$' && n === '{') { stack.push('interp'); out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c !== '\n') { txt[i] = c; out[i] = ' '; }
      i += 1;
      continue;
    }

    if (c === '/' && n === '/') { const end = src.indexOf('\n', i); blank(i, end < 0 ? src.length : end); i = end < 0 ? src.length : end; continue; }
    if (c === '/' && n === '*') { const end = src.indexOf('*/', i + 2); const to = end < 0 ? src.length : end + 2; blank(i, to); i = to; continue; }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j += 1; j += 1; }
      literal(i + 1, j);           // the contents are markup; the quotes are not
      blank(i, j + 1); i = j + 1; lastSignificant = 'x'; continue;
    }

    if (c === '`') { stack.push('template'); out[i] = ' '; i += 1; continue; }

    // A regex literal, told from division by what came before it.
    if (c === '/' && regexCanStart()) {
      let j = i + 1; let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') break;
        j += 1;
      }
      if (src[j] === '/') { while (j + 1 < src.length && /[gimsuyd]/.test(src[j + 1])) j += 1; blank(i, j + 1); i = j + 1; lastSignificant = 'x'; continue; }
    }

    if (c === '}' && stack.length && stack[stack.length - 1] === 'interp') { stack.pop(); out[i] = ' '; i += 1; continue; }

    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }
  return { code: out.join(''), text: txt.join('') };
}

/** Just the code half, which is what most of the checks below want. */
const stripNonCode = (src) => scan(src).code;
/** Just the literal half: every string and template body, and nothing else. */
const literalsOf = (src) => scan(src).text;

/**
 * HTML has no JavaScript quoting, so the scanner is the wrong tool for it.
 * Only comments come out; an attribute stays an attribute.
 */
const stripHtmlComments = (src) => src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

const decomment = stripNonCode;

/**
 * The scanner, checked against itself before it is trusted with anything.
 *
 * Every assertion below is a shape that has been got wrong here or is one step
 * away from it. A scanner that silently mis-parses does not fail; it stops
 * looking, and reports ok.
 */
{
  const collapse = (s) => s.replace(/ +/g, ' ');
  const cases = [
    ['division is not a regex',
      'const a = (x + y) / 2 + (z) / 3;', 'const a = (x + y) / 2 + (z) / 3;'],
    ['a regex is not division',
      "s.replace(/[a-z]/g, '')", 's.replace( , )'],
    ['a quote inside a regex does not open a string',
      "const q = /['\"]/; const after = 1;", 'const q = ; const after = 1;'],
    ['a template keeps the code inside its holes',
      'const t = `a ${fn(x)} b`;', 'const t = fn(x) ;'],
    ['nested templates come back out',
      'const t = `${`${inner(1)}`}`;', 'const t = inner(1) ;'],
    ['a comment marker inside a string is not a comment',
      "const u = 'https://x/y'; const after = 2;", 'const u = ; const after = 2;'],
    ['a slash inside a character class does not close the regex',
      "x.match(/[/]/); const after = 3;", 'x.match( ); const after = 3;'],
  ];
  for (const [what, input, want] of cases) {
    const got = collapse(stripNonCode(input)).trim();
    if (got !== collapse(want).trim()) {
      console.error(`check-shipped: the scanner is broken — ${what}`);
      console.error(`  input:    ${input}`);
      console.error(`  expected: ${collapse(want).trim()}`);
      console.error(`  got:      ${got}`);
      process.exit(1);
    }
  }

  // The other half, which two checks depend on and which was not there at all.
  const literals = [
    ['a template body is markup',
      'const t = `<i class="x">${n}</i>`;', '<i class="x"> </i>'],
    ['a string body is markup',
      "const u = 'https://x/y';", 'https://x/y'],
    ['a comment is neither',
      '// see https://x/y\nconst a = 1;', ''],
    ['a block comment is neither',
      '/* style="x" and https://y/z */\nconst a = 1;', ''],
  ];
  for (const [what, input, want] of literals) {
    const got = collapse(literalsOf(input)).replace(/\s+/g, ' ').trim();
    if (got !== collapse(want).replace(/\s+/g, ' ').trim()) {
      console.error(`check-shipped: the scanner's markup half is broken — ${what}`);
      console.error(`  input:    ${JSON.stringify(input)}`);
      console.error(`  expected: ${JSON.stringify(collapse(want).trim())}`);
      console.error(`  got:      ${JSON.stringify(got)}`);
      process.exit(1);
    }
  }
}

/* ---- 1. no inline style attributes ------------------------------------- */

/**
 * Over the *markup*, which is where an inline style is written.
 *
 * This ran over `decomment(...)` — the code half — so it was looking at the
 * one view of the file that has every template literal blanked out of it. The
 * views build their HTML in template literals and nowhere else, so the check
 * could not see a single one, and index.html fared no better: the scanner
 * treats `"` as a string delimiter, so every attribute in the file blanked
 * itself. It passed on `style="color: red"` in a view and in the page.
 */
const markupOf = (file) => (file.endsWith('.html')
  ? stripHtmlComments(readFileSync(file, 'utf8'))
  : literalsOf(readFileSync(file, 'utf8')));

for (const file of [...SRC, join(SITE, 'index.html')]) {
  const body = markupOf(file);
  const hits = [...body.matchAll(/style\s*=\s*["'][^"']+["']/g)];
  for (const h of hits) {
    const line = body.slice(0, h.index).split('\n').length;
    fail(`${rel(file)}:${line} has an inline style attribute — style-src 'self' refuses it. Use a class, or set it via the CSSOM in paint().`);
  }
}

/* ---- 2 + 3. every data-act and data-bind is handled -------------------- */

const app = readFileSync(join(SITE, 'src/app.js'), 'utf8');

const declaredActions = new Set(
  [...(app.match(/const ACTIONS = \{[\s\S]*?\n\};/) ?? [''])[0]
    .matchAll(/^\s*'?([\w-]+)'?\s*:/gm)].map((m) => m[1]),
);
const declaredBinds = new Set([...app.matchAll(/bind === '([\w-]+)'/g)].map((m) => m[1]));

for (const file of SRC) {
  const body = readFileSync(file, 'utf8');
  for (const m of body.matchAll(/data-act="([\w-]+)"/g)) {
    if (!declaredActions.has(m[1])) fail(`${rel(file)} renders data-act="${m[1]}" and app.js has no handler for it.`);
  }
  for (const m of body.matchAll(/data-bind="([\w-]+)"/g)) {
    if (!declaredBinds.has(m[1])) fail(`${rel(file)} renders data-bind="${m[1]}" and app.js has no branch for it.`);
  }
}

// And the other way: a handler nobody can reach is dead weight that reads as
// a feature.
const renderedActs = new Set(SRC.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/data-act="([\w-]+)"/g)].map((m) => m[1])));
for (const act of declaredActions) {
  if (!renderedActs.has(act)) fail(`app.js handles '${act}' and no view renders it.`);
}

/* ---- 4. every name a module calls resolves ----------------------------- */

const GLOBALS = new Set([
  'window', 'document', 'location', 'navigator', 'console', 'fetch', 'Request', 'Response',
  'URL', 'URLSearchParams', 'localStorage', 'caches', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'Blob', 'FileReader', 'CSS', 'Date', 'Math', 'JSON',
  'Object', 'Array', 'Number', 'String', 'Boolean', 'Set', 'Map', 'Promise', 'Error',
  'BigInt', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false', 'this', 'globalThis',
  'AbortController', 'self', 'crypto', 'structuredClone', 'queueMicrotask',
]);

for (const file of SRC) {
  const body = readFileSync(file, 'utf8');
  const code = decomment(body);

  // Deliberately permissive. The bug worth catching is a helper that exists in
  // one module and is called from another — a real ReferenceError on a real
  // screen. A check that also flags method shorthand and destructured
  // parameters is noise, and a noisy check gets deleted and is then worth
  // nothing on the day it mattered.
  const declared = new Set([
    ...[...code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...code.matchAll(/import\s+\{([^}]+)\}/g)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop().trim())),
    ...[...code.matchAll(/import\s+\*\s+as\s+([\w$]+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)].map((m) => m[1]),
    ...[...code.matchAll(/function\s+[\w$]*\s*\(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((x) => x.trim().split(/[=:{}\s]/)[0]).filter(Boolean)),
    // Object and class method shorthand: `run(ctx) {`, `key(i) {`.
    ...[...code.matchAll(/(?:^|\n)\s*([a-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)].map((m) => m[1]),
    // Anything bound by a destructuring pattern, in a parameter or otherwise:
    // `{ undo = null, ms = null }`, `const { ok, pick } = ...`.
    ...[...code.matchAll(/\{([^{}]*)\}\s*(?:=[^=]|\)|,)/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().replace(/^\.\.\./, '').split(/[=:\s]/)[0]))
      .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x)),
  ]);

  // Only calls, which is where a missing helper actually explodes.
  for (const m of code.matchAll(/(?<![.\w$'"`])([a-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (GLOBALS.has(name) || declared.has(name)) continue;
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new', 'do', 'else', 'import', 'async', 'function', 'yield', 'delete', 'void', 'in', 'of'].includes(name)) continue;
    const line = code.slice(0, m.index).split('\n').length;
    fail(`${rel(file)}:${line} calls ${name}(), which is neither declared, imported, nor a browser global.`);
  }
}

/* ---- 5. nothing reaches another origin --------------------------------- */

/**
 * Over the markup as well, for the same reason as check 1.
 *
 * A URL is written in a string or a template literal — a `fetch()` argument, a
 * `src=`, an `href=` — and this ran over the code half, which blanks both. It
 * passed on `https://evil.example.com/beacon.js` assigned to a constant and on
 * an `<img src>` in a view. That is the check the whole `connect-src 'self'`
 * claim rests on, and it could not fail.
 *
 * Comments stay excluded on purpose: several modules cite a github.com URL in
 * prose, and a check that fires on those is a check somebody deletes.
 */
const ALLOWED_ORIGIN = 'https://deadpool.averageideas.dev';
for (const file of [...SRC, join(SITE, 'index.html'), join(SITE, 'sw.js')]) {
  const body = readFileSync(file, 'utf8');
  const looking = file.endsWith('.html')
    ? [stripHtmlComments(body)]
    : [scan(body).code, scan(body).text];
  for (const where of looking) {
    for (const m of where.matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
      if (m[0].startsWith(ALLOWED_ORIGIN)) continue;
      if (m[0].startsWith('http://www.w3.org/')) continue;     // the SVG namespace
      fail(`${rel(file)} contains ${m[0]} — the app must only ever talk to its own origin.`);
    }
  }
}

/* ---- 6. the manifest points at files that exist ------------------------ */

const manifest = JSON.parse(readFileSync(join(SITE, 'manifest.webmanifest'), 'utf8'));
for (const i of manifest.icons ?? []) {
  if (!existsSync(join(SITE, i.src.replace(/^\//, '')))) fail(`manifest names ${i.src}, which is not on disk.`);
}
for (const s of manifest.shortcuts ?? []) {
  if (!s.url.startsWith('/')) fail(`manifest shortcut "${s.name}" has a relative url; it must be absolute within the scope.`);
}

/* ---- report ------------------------------------------------------------ */

if (problems.length) {
  console.error(`\ncheck-shipped: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('');
  process.exit(1);
}
console.log(`check-shipped: ok — ${SRC.length} modules, ${declaredActions.size} actions, ${declaredBinds.size} bindings`);
