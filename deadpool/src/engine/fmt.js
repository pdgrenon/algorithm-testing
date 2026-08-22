/**
 * Number formatting that matches Python's, digit for digit.
 *
 * This exists for one reason: the strategies' reasoning strings are part of
 * the parity contract. `entry_a_value` says "a projected future matchup is
 * about 12.4 points better", and if the port says 12.5 the golden test fails —
 * correctly, because a number shown to a person changed.
 *
 * The two languages disagree at exactly one place, and it is not obvious.
 * Python's format rounds half to EVEN; JavaScript's toFixed rounds half AWAY
 * from zero. They agree on almost every value and differ on the ones that land
 * exactly on a half, which is not rare here — a spread of 6.5 times the 1.2
 * points-to-probability constant is 7.8 exactly, and win percentages arrive as
 * two-decimal fractions that scale to clean quarters all the time.
 *
 *     (78.25).toFixed(1)      → '78.3'
 *     f"{78.25:.1f}"          → '78.2'
 *
 * So the rounding is done here on the decimal expansion, half to even.
 */

/**
 * Round to `digits` decimal places, ties to even, as a string.
 *
 * The expansion is taken 20 places past what is needed. toFixed is correctly
 * rounded at that width, and no value this engine handles — probabilities on a
 * 0–100 scale, spreads, and their products — carries enough significant tail
 * beyond twenty extra places to flip a tie. A double whose exact value is
 * x.x5000000000000000000001 would be rounded down here and up by Python; it is
 * not reachable from any arithmetic in this codebase.
 */
export function fixed(x, digits) {
  if (!Number.isFinite(x)) return String(x);

  const neg = x < 0 || Object.is(x, -0);
  const abs = Math.abs(x);
  const [ip, fp = ''] = abs.toFixed(Math.min(100, digits + 20)).split('.');

  const keep = fp.slice(0, digits).padEnd(digits, '0');
  const rest = fp.slice(digits);

  let up = false;
  const first = rest[0] ?? '0';
  if (first > '5') {
    up = true;
  } else if (first === '5') {
    // Anything nonzero after the 5 means it was never a tie.
    if (/[1-9]/.test(rest.slice(1))) up = true;
    else {
      const last = digits > 0 ? keep[digits - 1] : ip[ip.length - 1];
      up = Number(last) % 2 === 1;          // ties go to the even neighbour
    }
  }

  let n = BigInt(ip + keep);
  if (up) n += 1n;

  let out = n.toString();
  if (digits > 0) {
    out = out.padStart(digits + 1, '0');
    out = `${out.slice(0, -digits)}.${out.slice(-digits)}`;
  }
  return (neg ? '-' : '') + out;
}

/** Python `f"{x:.1f}"`. */
export const f1 = (x) => fixed(x, 1);

/** Python `f"{x:.3f}"`. */
export const f3 = (x) => fixed(x, 3);

/** Python `f"{x:.0f}"`. */
export const f0 = (x) => fixed(x, 0);

/**
 * Python `f"{x:.0%}"` — the fraction is scaled first, then rounded.
 *
 * Order matters and is easy to get backwards: Python multiplies by 100 and
 * then rounds, so 0.345 formats from 34.5 (a tie, resolved to even → '34%')
 * rather than from a pre-rounded 0.34.
 */
export const pct0 = (x) => `${fixed(x * 100, 0)}%`;
