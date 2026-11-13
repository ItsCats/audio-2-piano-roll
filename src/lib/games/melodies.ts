/**
 * Short tunes the import mini-games play, one note per point. All are public domain (composers who
 * died long ago, or traditional melodies); only the melody line is used, written out here as MIDI
 * note numbers (60 = middle C).
 *
 * - "Ode to Joy": Ludwig van Beethoven, Symphony No. 9 (1824; Beethoven died in 1827).
 * - "Twinkle, Twinkle, Little Star": the French folk tune "Ah ! vous dirai-je, maman" (printed in 1761).
 * - "Für Elise" (opening): Beethoven, Bagatelle WoO 59 (c. 1810, published 1867).
 * - "Minuet in G": Christian Petzold, from the 1725 notebook for Anna Magdalena Bach.
 */

export interface Melody {
  id: string;
  title: string;
  notes: readonly number[];
}

export const MELODIES: readonly Melody[] = [
  {
    id: 'ode-to-joy',
    title: 'Ode to Joy',
    // prettier-ignore
    notes: [
      64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62,
      64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60,
      62, 62, 64, 60, 62, 64, 65, 64, 60, 62, 64, 65, 64, 62, 60, 62, 55,
      64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 62, 60, 60,
    ],
  },
  {
    id: 'twinkle',
    title: 'Twinkle, Twinkle, Little Star',
    // prettier-ignore
    notes: [
      60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60,
      67, 67, 65, 65, 64, 64, 62, 67, 67, 65, 65, 64, 64, 62,
      60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60,
    ],
  },
  {
    id: 'fur-elise',
    title: 'Für Elise',
    // prettier-ignore
    notes: [
      76, 75, 76, 75, 76, 71, 74, 72, 69, 60, 64, 69, 71, 64, 68, 71, 72,
      64, 76, 75, 76, 75, 76, 71, 74, 72, 69, 60, 64, 69, 71, 64, 72, 71, 69,
    ],
  },
  {
    id: 'minuet-in-g',
    title: 'Minuet in G',
    // prettier-ignore
    notes: [
      74, 67, 69, 71, 72, 74, 67, 67, 76, 72, 74, 76, 78, 79, 67, 67,
      72, 74, 72, 71, 69, 71, 72, 71, 69, 67, 66, 67, 69, 71, 67, 69,
    ],
  },
];

/** Plays a melody note by note, then moves on to the next tune. */
export interface MelodyCursor {
  melody: number;
  note: number;
}

export function melodyCursor(start = 0): MelodyCursor {
  return { melody: ((start % MELODIES.length) + MELODIES.length) % MELODIES.length, note: 0 };
}

/** The note at the cursor (a MIDI note number). */
export function currentNote(c: MelodyCursor): number {
  return MELODIES[c.melody].notes[c.note];
}

/** The note at the cursor, and the cursor moved on (wrapping to the next tune at the end). */
export function nextNote(c: MelodyCursor): { pitch: number; cursor: MelodyCursor } {
  const pitch = currentNote(c);
  const m = MELODIES[c.melody];
  const cursor = c.note + 1 < m.notes.length ? { melody: c.melody, note: c.note + 1 } : { melody: (c.melody + 1) % MELODIES.length, note: 0 };
  return { pitch, cursor };
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** "C", "F♯"… (no octave) */
export function noteName(pitch: number): string {
  return NAMES[((pitch % 12) + 12) % 12];
}

/** whether the note is a black key */
export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
}

const WHITE_INDEX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];

/** The white key a note sits on (a black key counts as the white key to its left), counted from C-1. */
export function whiteKeyIndex(pitch: number): number {
  const oct = Math.floor(pitch / 12);
  return oct * 7 + WHITE_INDEX[((pitch % 12) + 12) % 12];
}
