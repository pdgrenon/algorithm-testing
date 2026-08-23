/**
 * Inline SVG only.
 *
 * `img-src 'self'` does not match a data: URI, and an icon font would need a
 * font-src exception for a handful of glyphs. Inline markup needs neither, and
 * it inherits currentColor so an icon is never a colour that has to be kept in
 * step with the text beside it.
 */

const svg = (body, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
        aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  // A target, not a stack of lines. The first draft was three rules with a
  // dot, which is a hamburger menu at 21px however it was drawn at 200 —
  // judge a mark at the size it is used at, in the row it sits in.
  week: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  board: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M14.5 14.5l5 5M19.5 14.5l-5 5"/>',
  season: '<path d="M4 19V9M9.5 19V5M15 19v-7M20.5 19v-4"/>',
  // Two figures rather than one, because the screen is about everybody else.
  // A single silhouette reads as "account" in every app anybody has used.
  pool: '<circle cx="8" cy="8.5" r="2.7"/><circle cx="16.5" cy="8.5" r="2.7"/><path d="M3 19c0-2.7 2.2-4.6 5-4.6s5 1.9 5 4.6"/><path d="M14.2 14.6c2.4.3 4.3 2.1 4.3 4.4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3"/>',
  chevron: '<path d="M6 9.5l6 6 6-6"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.2 2"/>',
  alert: '<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  swap: '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>',
  undo: '<path d="M4 9h9a5 5 0 010 10H8"/><path d="M7.5 5.5L4 9l3.5 3.5"/>',
  download: '<path d="M12 3.5v11M8 11l4 4 4-4"/><path d="M4.5 19.5h15"/>',
  upload: '<path d="M12 20V9M8 12.5l4-4 4 4"/><path d="M4.5 4.5h15"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13"/>',
};

export const icon = (name, size = 20) => svg(ICONS[name] ?? '', size);

/**
 * The mark's geometry, on a 24x24 grid, with its presentation as arguments.
 *
 * Exported because scripts/make-icons.mjs rasterises the same shape for the
 * launcher icons, and its own docstring says the mark is "defined once, in
 * src/ui/icons.js ... rather than keeping a second copy of it in a drawing
 * file that would drift". It was a second copy, and it had drifted: identical
 * coordinates, three different opacities. The coordinates are the half worth
 * sharing -- a typo in one of them is invisible until somebody compares a
 * masthead to a home screen -- and the colours and weights are deliberately
 * not, because a mark at 48px in a launcher is not the same drawing problem
 * as a mark at 26px beside a wordmark.
 */
export const markGeometry = ({
  ink = 'currentColor',
  lit = 'currentColor',
  frame = 0.35,
  cell = 0.22,
  strike = 0.6,
} = {}) => `
  <rect x="1.5" y="1.5" width="21" height="21" rx="3" stroke="${ink}" stroke-width="1.4" opacity="${frame}" fill="none"/>
  <rect x="5" y="5" width="5.6" height="5.6" rx="1" fill="${ink}" opacity="${cell}"/>
  <rect x="13.4" y="5" width="5.6" height="5.6" rx="1" fill="${ink}" opacity="${cell}"/>
  <rect x="5" y="13.4" width="5.6" height="5.6" rx="1" fill="${ink}" opacity="${cell}"/>
  <rect x="13.4" y="13.4" width="5.6" height="5.6" rx="1" fill="${lit}"/>
  <g stroke="${ink}" stroke-width="1.35" stroke-linecap="round" opacity="${strike}">
    <path d="M5.9 5.9l3.8 3.8M9.7 5.9l-3.8 3.8"/>
    <path d="M14.3 5.9l3.8 3.8M18.1 5.9l-3.8 3.8"/>
    <path d="M5.9 14.3l3.8 3.8M9.7 14.3l-3.8 3.8"/>
  </g>`;

/**
 * The mark: a board that fills up, with one square still lit.
 *
 * The subject's own object. A survivor pool is a grid of teams you burn
 * through until there is nothing left, so the mark is that grid with cells
 * struck out and one alive.
 *
 * Three drafts were rejected before this, all for the same reason — they were
 * judged at 512px and read as something else entirely at 22px next to the
 * wordmark. A shield is every sports app ever made. A chevron is the "next"
 * arrow on a carousel. A tombstone is a joke about the name, and the app is
 * about surviving rather than about dying. Render a candidate at 16, 22 and in
 * the real lockup before choosing.
 *
 * Monochrome here on purpose: it sits beside a wordmark on a screen where the
 * state colours are carrying real meaning, so the lit cell inherits
 * currentColor like everything else. The launcher icon is the one place it is
 * jade, because there it is the whole point.
 */
export const mark = (size = 24) => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">${markGeometry()}
</svg>`;
