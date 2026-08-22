/**
 * Toast, undo and haptics.
 *
 * One rule: nothing this app does on your behalf happens silently, and
 * anything it does to the record can be taken back. Recording a pick is the
 * only destructive action in normal use — it overwrites whatever was in that
 * slot — so it always comes with an undo attached to the confirmation rather
 * than buried in a menu.
 */

let node = null;
let hideTimer = null;

function ensure() {
  if (node) return node;
  node = document.createElement('div');
  node.className = 'toast';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  document.body.appendChild(node);
  return node;
}

/**
 * Say what happened.
 *
 * `undo` is a function; when given, the toast carries the control and stays up
 * longer, because reading a sentence and deciding to reverse it takes more
 * than the two seconds a plain acknowledgement needs.
 */
export function toast(message, { undo = null, ms = null } = {}) {
  const el = ensure();
  clearTimeout(hideTimer);

  el.textContent = '';
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);

  if (undo) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--ghost btn--sm toast__undo';
    button.textContent = 'Undo';
    button.addEventListener('click', () => { hide(); undo(); }, { once: true });
    el.appendChild(button);
  }

  el.classList.add('toast--in');
  hideTimer = setTimeout(hide, ms ?? (undo ? 7000 : 2600));
}

function hide() {
  if (node) node.classList.remove('toast--in');
}

/**
 * A short buzz on a commit.
 *
 * Guarded twice: not every device has a vibrator, and iOS Safari has none at
 * all — an unguarded call throws there and would take the tap with it.
 */
export function haptic(pattern = 8) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch { /* the tap matters more than the buzz */ }
}

/** A blocking yes/no, for the two things that cannot be undone. */
export const confirmDestructive = (message) => window.confirm(message);
