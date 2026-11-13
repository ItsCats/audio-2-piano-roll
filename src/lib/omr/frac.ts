/**
 * Exact fractions for score time (quarter notes), so triplets and other tuplets stay exact through
 * the **kern → MusicXML step (src/lib/omr). Immutable; always reduced, denominator > 0.
 */
export interface Frac {
  readonly n: number;
  readonly d: number;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/** Largest denominator kept exact; beyond it a value is rounded to 1/LIMIT_ROUND quarters. */
const LIMIT = 1 << 20;
const LIMIT_ROUND = 2520;

export function frac(n: number, d = 1): Frac {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return { n: 0, d: 1 };
  if (!Number.isInteger(n) || !Number.isInteger(d)) return fromNumber(n / d);
  if (d < 0) (n = -n), (d = -d);
  const g = gcd(n, d);
  n /= g;
  d /= g;
  if (d > LIMIT) return frac(Math.round((n / d) * LIMIT_ROUND), LIMIT_ROUND);
  return { n, d };
}

/** Closest fraction with denominator ≤ LIMIT_ROUND. */
export function fromNumber(x: number): Frac {
  return frac(Math.round(x * LIMIT_ROUND), LIMIT_ROUND);
}

export const ZERO = frac(0);
export const add = (a: Frac, b: Frac): Frac => frac(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Frac, b: Frac): Frac => frac(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Frac, b: Frac): Frac => frac(a.n * b.n, a.d * b.d);
export const div = (a: Frac, b: Frac): Frac => (b.n === 0 ? ZERO : frac(a.n * b.d, a.d * b.n));
export const cmp = (a: Frac, b: Frac): number => a.n * b.d - b.n * a.d;
export const eq = (a: Frac, b: Frac): boolean => a.n === b.n && a.d === b.d;
export const max = (a: Frac, b: Frac): Frac => (cmp(a, b) >= 0 ? a : b);
export const min = (a: Frac, b: Frac): Frac => (cmp(a, b) <= 0 ? a : b);
export const num = (a: Frac): number => a.n / a.d;

/** Least common multiple of the denominators (MusicXML <divisions>), capped. */
export function lcmDen(values: Iterable<Frac>, cap = 10080): number {
  let l = 1;
  for (const v of values) {
    const next = (l * v.d) / gcd(l, v.d);
    if (next > cap) return cap;
    l = next;
  }
  return l;
}
