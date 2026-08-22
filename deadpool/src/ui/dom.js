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
export function captureFocus(root) {
  const el = document.activeElement;
  if (!el || !root.contains(el)) return null;
  const acted = el.closest('[data-act]');
  if (!acted) return null;
  return { act: acted.dataset.act, key: acted.dataset.key ?? null };
}

export function restoreFocus(root, anchor) {
  if (!anchor) return;
  const selector = anchor.key
    ? `[data-act="${CSS.escape(anchor.act)}"][data-key="${CSS.escape(anchor.key)}"]`
    : `[data-act="${CSS.escape(anchor.act)}"]`;
  const target = root.querySelector(selector) ?? root.querySelector(`[data-act="${CSS.escape(anchor.act)}"]`);
  if (target) target.focus({ preventScroll: true });
}
