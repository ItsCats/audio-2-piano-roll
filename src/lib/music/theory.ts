import type { KeyInfo, Note } from './types';

export const PIANO_MIN = 21; // A0
export const PIANO_MAX = 108; // C8

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const ASCII_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SOLFEGE_SHARP = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
const SOLFEGE_FLAT = ['Do', 'Re♭', 'Re', 'Mi♭', 'Mi', 'Fa', 'Sol♭', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

export const isBlack = (midi: number): boolean => BLACK[((midi % 12) + 12) % 12];
export const pitchClass = (midi: number): number => ((midi % 12) + 12) % 12;
export const octaveOf = (midi: number): number => Math.floor(midi / 12) - 1;

export function noteName(midi: number, opts: { flats?: boolean; octave?: boolean; ascii?: boolean } = {}): string {
  const pc = pitchClass(midi);
  const base = opts.ascii ? ASCII_SHARP[pc] : opts.flats ? FLAT_NAMES[pc] : SHARP_NAMES[pc];
  return opts.octave === false ? base : `${base}${octaveOf(midi)}`;
}

export function parseNoteName(name: string): number | null {
  const m = /^([A-Ga-g])([#♯b♭]?)(-?\d)$/.exec(name.trim());
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return base + acc + (parseInt(m[3], 10) + 1) * 12;
}

export type LabelStyle = 'none' | 'letter' | 'letter-octave' | 'solfege' | 'number' | 'custom';
export type Accidentals = 'sharps' | 'flats' | 'auto';

export function formatLabel(
  midi: number,
  style: LabelStyle,
  accidentals: 'sharps' | 'flats',
  custom?: string[],
): string {
  const pc = pitchClass(midi);
  const flats = accidentals === 'flats';
  switch (style) {
    case 'none':
      return '';
    case 'letter':
      return (flats ? FLAT_NAMES : SHARP_NAMES)[pc];
    case 'letter-octave':
      return noteName(midi, { flats });
    case 'solfege':
      return (flats ? SOLFEGE_FLAT : SOLFEGE_SHARP)[pc];
    case 'number':
      return String(midi);
    case 'custom':
      return custom?.[pc] ?? '';
  }
}

export const midiToFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Krumhansl–Schmuckler key estimation on a duration-weighted pitch-class histogram. */
export function detectKey(notes: Note[]): KeyInfo | undefined {
  if (notes.length < 8) return undefined;
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[pitchClass(n.midi)] += Math.min(n.dur, 2) * (0.5 + n.vel);
  let best: KeyInfo | undefined;
  let second = -Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      const rotated = profile.map((_, i) => profile[(i - tonic + 12) % 12]);
      const r = correlation(hist, rotated);
      if (!best || r > best.confidence) {
        if (best) second = Math.max(second, best.confidence);
        best = { tonic, mode, confidence: r, name: '' };
      } else {
        second = Math.max(second, r);
      }
    }
  }
  if (!best) return undefined;
  const flats = prefersFlats(best.tonic, best.mode);
  best.name = `${(flats ? FLAT_NAMES : SHARP_NAMES)[best.tonic]} ${best.mode}`;
  // squash to 0..1: correlation strength and margin to runner-up
  best.confidence = Math.max(0, Math.min(1, best.confidence * 0.7 + (best.confidence - second) * 3));
  return best;
}

/** Whether a key signature is conventionally written with flats. */
export function prefersFlats(tonic: number, mode: 'major' | 'minor'): boolean {
  const majorTonic = mode === 'major' ? tonic : (tonic + 3) % 12;
  // F, Bb, Eb, Ab, Db, Gb use flats
  return [5, 10, 3, 8, 1, 6].includes(majorTonic);
}

export function formatTime(seconds: number, withMs = false): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const base = `${sign}${m}:${sec.toString().padStart(2, '0')}`;
  if (!withMs) return base;
  return `${base}.${Math.floor((s % 1) * 10)}`;
}
