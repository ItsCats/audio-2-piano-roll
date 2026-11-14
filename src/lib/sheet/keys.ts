/** Key signatures of a Score by measure (Song.sheet.keys), and their minor-key tonic. */
import type { KeySig, Score } from './types';

/** The pitch class of the tonic of a minor key with this signature. */
export const minorTonicOf = (fifths: number): number => ((((fifths * 7) % 12) + 12 + 9) % 12);

/** The key signature in force in measure m. */
export function keyAt(score: Pick<Score, 'keys' | 'fifths' | 'mode' | 'minorTonic'>, m: number): KeySig {
  const ks = score.keys;
  if (!ks || ks.length <= 1) return ks?.[0] ?? { measure: 0, fifths: score.fifths, mode: score.mode, minorTonic: score.minorTonic };
  let lo = 0;
  let hi = ks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ks[mid].measure <= m) lo = mid;
    else hi = mid - 1;
  }
  return ks[lo];
}

/** Whether measure m starts a new key signature (m > 0). */
export function keyChangeAt(score: Pick<Score, 'keys'>, m: number): KeySig | null {
  if (m <= 0) return null;
  const k = score.keys?.find((x) => x.measure === m);
  return k ?? null;
}
