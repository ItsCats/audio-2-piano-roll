/** Loudness of the dynamic marks (shared with the score importer: lib/score/ir.ts DYNAMIC_VEL). */
import type { DynamicValue } from '../music/types';
import { ACCENT_DYNAMIC, DYNAMIC_VEL } from '../score/ir';

/** Level dynamics (pp … fff) and accent dynamics (sf, sfz, fp: the velocity of the struck notes). */
export const DYNAMIC_LEVEL: Record<DynamicValue, number> = {
  pp: DYNAMIC_VEL.pp,
  p: DYNAMIC_VEL.p,
  mp: DYNAMIC_VEL.mp,
  mf: DYNAMIC_VEL.mf,
  f: DYNAMIC_VEL.f,
  ff: DYNAMIC_VEL.ff,
  fff: DYNAMIC_VEL.fff,
  sf: ACCENT_DYNAMIC.sf.vel,
  sfz: ACCENT_DYNAMIC.sfz.vel,
  fp: ACCENT_DYNAMIC.fp.vel,
};

/** sf, sfz and fp change only the notes struck where they are written (fp then continues at p). */
export const isAccentDynamic = (v: DynamicValue) => v === 'sf' || v === 'sfz' || v === 'fp';
/** The level after an accent dynamic (fp: .40), or null when the level in force continues. */
export const afterAccent = (v: DynamicValue): number | null => (v === 'fp' ? (ACCENT_DYNAMIC.fp.after ?? DYNAMIC_VEL.p) : null);
