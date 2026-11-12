/**
 * The common, format-independent form of a score file (MusicXML or MuseScore) before it is
 * performed: measures in written order with their notes, directions and repeat structure.
 * Positions and durations are in quarter notes (floats; triplets are thirds), measured from the
 * start of the measure.
 */

export interface IRNote {
  /** Index into ScoreIR.parts. */
  part: number;
  /** Staff of the part (1-based). */
  staff: number;
  /** Voice id within the part (any string; only compared for equality). */
  voice: string;
  pos: number;
  /** Written length in quarters (0 for grace notes). */
  dur: number;
  /** Sounding MIDI pitch (transposition and octave marks applied). */
  midi: number;
  /** A tie continues into the next note of the same pitch. */
  tieStart?: boolean;
  /** This note continues a tie from the previous note of the same pitch. */
  tieStop?: boolean;
  /** Grace note: slashed (acciaccatura, short) or not (appoggiatura, takes half the main note). */
  grace?: 'acciaccatura' | 'appoggiatura';
  /** Grace notes that come after their main note (MuseScore "grace after"). */
  graceAfter?: boolean;
  /** Sounds together with the previous note of the file (a chord tone; used for grace chords). */
  chord?: boolean;
  /** Order within the file, to keep grace notes in written order. */
  seq: number;
  /** Explicit velocity 0..1 for this note (MusicXML dynamics="…", MuseScore velocity). */
  vel?: number;
  /** Extra velocity from an accent mark (0..1). */
  accent?: number;
}

export interface IRDynamic {
  part: number;
  pos: number;
  /** 0..1 */
  vel: number;
  /** 'level' changes the dynamic from here on; 'accent' (sf, sfz, fz …) only applies to notes struck here. */
  kind: 'level' | 'accent';
  /** fp / sfp: the level after the accented note. */
  after?: number;
}

export interface IRJump {
  to: 'start' | 'segno';
  alFine?: boolean;
  alCoda?: boolean;
}

export interface IRMeasure {
  /** Number printed in the score (for messages). */
  label: string;
  /** Length in quarters as played (the content, or the time signature when the measure is empty). */
  length: number;
  /** The time signature in force. */
  beats: number;
  beatType: number;
  /** The measure is marked as incomplete (pickup / anacrusis). */
  implicit?: boolean;
  /** A new time signature starts here. */
  timeChange?: boolean;
  /** A key signature starts here (concert pitch). */
  key?: { fifths: number; mode: 'major' | 'minor' };
  /** Tempo marks: quarter notes per minute at a position. */
  tempos: { pos: number; qpm: number }[];
  notes: IRNote[];
  dynamics: IRDynamic[];
  /** Sustain pedal down/up at a position ('change' = up and down again). */
  pedal: { pos: number; type: 'down' | 'up' | 'change' }[];
  /** Fermatas over notes or rests: the span that is held longer. */
  fermatas: { pos: number; dur: number }[];
  // repeat structure
  repeatStart?: boolean;
  /** A backward repeat at the end: total number of times the section is played (usually 2). */
  repeatEnd?: number;
  /** Inside a volta bracket: which passes play it; `id` tells adjacent brackets apart. */
  ending?: { id: number; passes: number[] };
  segno?: boolean;
  /** The coda section starts here. */
  coda?: boolean;
  /** "To Coda": on the pass after a D.C./D.S., jump to the coda after this measure. */
  toCoda?: boolean;
  /**
   * A coda sign whose meaning the file doesn't say (MusicXML <coda/> without <sound>): "To Coda"
   * before the D.C./D.S., the start of the coda after it (resolveCodaSigns).
   */
  codaSign?: { pos: number };
  /** "Fine": on the pass after a D.C./D.S. al Fine, stop after this measure. */
  fine?: boolean;
  /** D.C. / D.S. at the end of this measure. */
  jump?: IRJump;
}

export interface IRPart {
  name: string;
  /** Number of staves. */
  staves: number;
  /** Looks like a keyboard part (piano, organ, harpsichord, keyboard, or a 2-staff grand staff). */
  keyboard: boolean;
  /** Notes of this part are not played (percussion). */
  ignored?: boolean;
}

export interface ScoreIR {
  title?: string;
  composer?: string;
  parts: IRPart[];
  measures: IRMeasure[];
  warnings: string[];
}

/** Velocities of dynamic marks (0..1). */
export const DYNAMIC_VEL: Record<string, number> = {
  pppppp: 0.1,
  ppppp: 0.12,
  pppp: 0.15,
  ppp: 0.2,
  pp: 0.3,
  p: 0.4,
  mp: 0.5,
  mf: 0.6,
  f: 0.72,
  ff: 0.84,
  fff: 0.92,
  ffff: 0.96,
  fffff: 0.98,
  ffffff: 1,
  n: 0.1,
};
/** Accent dynamics: velocity of the accented note (and the level after it for fp / sfp). */
export const ACCENT_DYNAMIC: Record<string, { vel: number; after?: number }> = {
  sf: { vel: 0.85 },
  sfz: { vel: 0.88 },
  sffz: { vel: 0.95 },
  fz: { vel: 0.85 },
  rf: { vel: 0.8 },
  rfz: { vel: 0.82 },
  sfzp: { vel: 0.88, after: 0.4 },
  sfp: { vel: 0.85, after: 0.4 },
  sfpp: { vel: 0.85, after: 0.3 },
  fp: { vel: 0.75, after: 0.4 },
  pf: { vel: 0.4, after: 0.72 },
};
export const DEFAULT_VEL = 0.6;
export const DEFAULT_QPM = 120;

/** Tempo words → quarter notes per minute, for scores that have words but no metronome mark. */
const TEMPO_WORDS: [RegExp, number][] = [
  [/\bgrave\b/, 40],
  [/\blarghissimo\b/, 40],
  [/\blargo\b/, 50],
  [/\blento\b/, 56],
  [/\blarghetto\b/, 63],
  [/\badagietto\b/, 72],
  [/\badagio\b/, 66],
  [/\bandantino\b/, 84],
  [/\bandante\b/, 76],
  [/\bmoderato\b/, 104],
  [/\ballegretto\b/, 112],
  [/\ballegro\b/, 132],
  [/\bvivace\b/, 160],
  [/\bvivacissimo\b/, 172],
  [/\bpresto\b/, 176],
  [/\bprestissimo\b/, 200],
];

/** Quarter notes per minute suggested by tempo words ("Allegro moderato" → the first word wins). */
export function tempoFromWords(words: string): number | null {
  const w = words.toLowerCase();
  let best: { at: number; qpm: number } | null = null;
  for (const [re, qpm] of TEMPO_WORDS) {
    const m = re.exec(w);
    if (m && (!best || m.index < best.at)) best = { at: m.index, qpm };
  }
  return best?.qpm ?? null;
}

/** Repeat / jump instructions written as words ("D.S. al Coda", "To Coda", "Fine"). */
export function jumpFromWords(words: string): { jump?: IRJump; toCoda?: boolean; fine?: boolean; coda?: boolean; segno?: boolean } | null {
  const w = words
    .toLowerCase()
    .replace(/[.\s '’]+/g, '')
    .replace(/𝄋/g, 'segno')
    .replace(/𝄌/g, 'coda');
  if (!w) return null;
  if (/^(tocoda|alcoda)$/.test(w) || /^tocoda/.test(w)) return { toCoda: true };
  const dc = /^(dc|dacapo)(al|alla)?(fine|coda)?/.exec(w);
  if (dc) return { jump: { to: 'start', alFine: dc[3] === 'fine', alCoda: dc[3] === 'coda' } };
  const ds = /^(ds|dalsegno)(al|alla)?(fine|coda)?/.exec(w);
  if (ds) return { jump: { to: 'segno', alFine: ds[3] === 'fine', alCoda: ds[3] === 'coda' } };
  if (w === 'fine') return { fine: true };
  if (w === 'coda') return { coda: true };
  if (w === 'segno') return { segno: true };
  return null;
}

/** "1, 2", "1-3", "1." → [1, 2], [1, 2, 3], [1]. */
export function parseEndingNumbers(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(/[,\s]+/)) {
    const r = /^(\d+)\s*[-–]\s*(\d+)/.exec(part);
    if (r) {
      for (let k = +r[1]; k <= +r[2] && k < 100; k++) out.push(k);
      continue;
    }
    const m = /(\d+)/.exec(part);
    if (m) out.push(+m[1]);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Gives coda signs of unknown meaning their role: signs after the last D.C./D.S. start the coda;
 * a sign before it is "To Coda" (after its measure when it sits in the second half of the measure,
 * else after the previous measure). Files that say which is which are left as they are.
 */
export function resolveCodaSigns(measures: IRMeasure[]): void {
  const signs = measures.map((m, i) => (m.codaSign ? i : -1)).filter((i) => i >= 0);
  if (!signs.length) return;
  let lastJump = -1;
  measures.forEach((m, i) => m.jump && (lastJump = i));
  const hasTo = measures.some((m) => m.toCoda);
  const hasCoda = measures.some((m) => m.coda);
  for (const i of signs) {
    const m = measures[i];
    const sign = m.codaSign!;
    delete m.codaSign;
    const after = lastJump >= 0 ? i > lastJump : i === signs[signs.length - 1] && signs.length > 1;
    if (after) {
      if (!hasCoda) m.coda = true;
    } else if (!hasTo) {
      const at = sign.pos >= m.length / 2 || i === 0 ? i : i - 1;
      measures[at].toCoda = true;
    }
  }
}
