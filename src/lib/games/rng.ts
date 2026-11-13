/** Small seeded random numbers (mulberry32) so game runs are reproducible in tests. */
export interface Rng {
  state: number;
}

export function makeRng(seed: number): Rng {
  return { state: seed >>> 0 || 0x9e3779b9 };
}

/** a number in [0, 1) */
export function nextRandom(r: Rng): number {
  r.state = (r.state + 0x6d2b79f5) >>> 0;
  let t = r.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** an integer in [0, n) */
export function randomInt(r: Rng, n: number): number {
  return Math.floor(nextRandom(r) * n);
}
