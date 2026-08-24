/**
 * Rendering helpers.
 *
 * Views build HTML as strings and assign it, which is fast and easy to read.
 * That makes two things non-negotiable, and both live here.
 *
 * `esc` runs over every value that comes from data. Team names come from
 * ESPN, entry names come from the person using the app, and a note could come
 * from an imported backup. None of it is trusted into the DOM raw.
 *
 * `paint` exists because `_headers` ships style-src 'self' with no
 * 'unsafe-inline'. A style="" attribute written into an HTML string is refused
 * by the browser, so anything with a computed geometry — a probability bar's
 * width — carries a data attribute instead and gets its value set through the
 * CSSOM after the markup lands. The CSSOM is not a parsed style string, so CSP
 * does not govern it, and the app keeps the strict policy rather than opening
 * it up for four bar widths.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** Join class names, dropping anything falsy, so callers can use && inline. */
export const cx = (...parts) => parts.filter(Boolean).join(' ');

/**
 * Apply every computed geometry in a subtree.
 *
 *   data-fill="0.78"     → width: 78%
 *   data-width="120px"   → width: 120px
 *
 * Clamped, because a probability that arrives above 1 or below 0 should draw a
 * full or empty bar rather than a bar wider than its own track.
 */
export function paint(root) {
  for (const node of root.querySelectorAll('[data-fill]')) {
    const raw = Number(node.dataset.fill);
    const fraction = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    node.style.width = `${(fraction * 100).toFixed(2)}%`;
  }
  for (const node of root.querySelectorAll('[data-width]')) {
    node.style.width = node.dataset.width;
  }
  return root;
}

/**
 * Wire one delegated click handler for a subtree.
 *
 * Delegation rather than per-node listeners, because every view re-renders by
 * wholesale innerHTML assignment and individually-attached handlers would be
 * thrown away and re-attached on every tap.
 */
export function onAction(root, handlers) {
  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-act]');
    if (!target || !root.contains(target)) return;
    const fn = handlers[target.dataset.act];
    if (!fn) return;
    event.preventDefault();
    fn(target.dataset, target, event);
  });
}

/**
 * Where the keyboard was, so a re-render can put it back.
 *
 * Every view here re-renders by assigning innerHTML, which destroys the
 * control that was just activated — and for anyone driving this by keyboard or
 * screen reader, that throws the reading cursor to the top of the page on
 * every single tap. Anchored on the action and its key rather than on an
 * index, because lists here reorder.
 */
/**
 * Which disclosures are open, so a re-render can put them back.
 *
 * Same problem as `captureFocus` and the same shape of answer. It lived in
 * views/settings.js, keyed on `details[id]`, and only that view called it —
 * so the Week screen's "Why this pick" and "Pick something else" panels, which
 * carry no id, collapsed on every re-render. The Week screen re-renders on a
 * sixty-second timer and on every visibilitychange, which means the one panel
 * somebody is actually reading, on the one screen the app is designed around,
 * shut itself within a minute of being opened.
 *
 * Optional-called throughout because views are also rendered to a plain
 * `{ innerHTML: '' }` in the suite, which has no DOM methods — and "nothing
 * was open" is the right answer for a root that cannot have been open.
 */
export const captureOpen = (root) => new Set(
  [...(root.querySelectorAll?.('details[id]') ?? [])].filter((d) => d.open).map((d) => d.id),
);

export function restoreOpen(root, open) {
  if (!open || !open.size) return;
  for (const d of root.querySelectorAll?.('details[id]') ?? []) d.open = open.has(d.id);
}

export function captureFocus(root) {
  const el = document.activeElement;
  if (!el || !root.contains(el)) return null;

  // `[data-act]` is a button. `[data-bind]` is a settings control, and it was
  // not anchored at all — so every input, select and range on the Settings
  // screen dropped focus to <body> the moment it fired `change`, because the
  // handler ends in a full re-render. A range fires `change` on each arrow-key
  // press, which made every slider unusable from the keyboard after exactly
  // one keystroke. The same re-render was already known to destroy <details>
  // state and was fixed for that; focus was not.
  const bound = el.closest('[data-act], [data-bind]');
  if (!bound) return null;

  const anchor = {
    act: bound.dataset.act ?? null,
    bind: bound.dataset.bind ?? null,
    // `key` disambiguates a per-strategy parameter; `entry` a per-entry field.
    key: bound.dataset.key ?? null,
    entry: bound.dataset.entry ?? null,
    start: null,
    end: null,
  };

  // A text field also loses the caret, which turns a rename into a fight.
  // `selectionStart` throws on input types that do not support it, so this is
  // asked for rather than assumed.
  try {
    if (typeof el.selectionStart === 'number') {
      anchor.start = el.selectionStart;
      anchor.end = el.selectionEnd;
    }
  } catch { /* not a text-like input */ }

  return anchor;
}

export function restoreFocus(root, anchor) {
  if (!anchor) return;

  const attr = (name, value) => `[${name}="${CSS.escape(value)}"]`;
  const base = anchor.act !== null ? attr('data-act', anchor.act) : attr('data-bind', anchor.bind);
  const qualifiers = [
    anchor.key !== null ? attr('data-key', anchor.key) : '',
    anchor.entry !== null ? attr('data-entry', anchor.entry) : '',
  ].join('');

  const target = root.querySelector(base + qualifiers) ?? root.querySelector(base);
  if (!target) return;

  target.focus({ preventScroll: true });
  if (anchor.start === null) return;
  try { target.setSelectionRange(anchor.start, anchor.end); } catch { /* as above */ }
}
