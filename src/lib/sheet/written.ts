/**
 * What is written where: every written note piece of a Score (the same walk as the MusicXML writer)
 * keyed by `${measure}|${xmlVoice}|${pos}|${midi}`, with the Song note ids it stands for. Rendering
 * matches OSMD's drawn noteheads to these keys, so a click on the sheet maps exactly to Song notes.
 */
import { buckets, voiceItems } from './voiceItems';
import type { Score, Staff } from './types';

export interface WrittenNote {
  key: string;
  /** Song note ids (several when duplicates were merged into one written note). */
  ids: number[];
  staff: Staff;
  /** MusicXML voice: 1 / 2 on the treble staff, 5 / 6 on the bass staff. */
  voice: number;
  measure: number;
  midi: number;
  /** This piece (a tied note is written as several pieces). */
  pieceOn: number;
  pieceOff: number;
  /** The whole written note. */
  chordOn: number;
  chordOff: number;
  first: boolean;
  last: boolean;
  /** Written as a chord tone together with other pitches. */
  inChord: boolean;
}

export interface WrittenIndex {
  byKey: Map<string, WrittenNote>;
  /** Pieces of each Song note id, in time order. */
  byId: Map<number, WrittenNote[]>;
}

export const writtenKey = (measure: number, voice: number, pos: number, midi: number) => `${measure}|${voice}|${pos}|${midi}`;

const memo = new WeakMap<Score, WrittenIndex>();

export function writtenIndex(score: Score): WrittenIndex {
  const hit = memo.get(score);
  if (hit) return hit;
  const byKey = new Map<string, WrittenNote>();
  const byId = new Map<number, WrittenNote[]>();
  const bk = buckets(score);
  for (let m = 0; m < score.measureCount; m++) {
    for (const s of [0, 1] as const) {
      for (const v of [0, 1] as const) {
        const chords = bk[s][v][m];
        if (v === 1 && !chords.length) continue;
        const voiceNo = (s === 0 ? 1 : 5) + v;
        for (const it of voiceItems(score, chords, m, v)) {
          if (it.kind !== 'note' || !it.chord) continue;
          const c = it.chord;
          c.midis.forEach((midi, j) => {
            const key = writtenKey(m, voiceNo, it.piece.pos, midi);
            const w: WrittenNote = {
              key,
              ids: c.srcByMidi?.[j] ?? [],
              staff: (s + 1) as Staff,
              voice: voiceNo,
              measure: m,
              midi,
              pieceOn: it.piece.pos,
              pieceOff: it.piece.pos + it.piece.dur,
              chordOn: c.on,
              chordOff: c.off,
              first: !it.tieStop,
              last: !it.tieStart,
              inChord: c.midis.length > 1,
            };
            byKey.set(key, w);
            for (const id of w.ids) {
              let a = byId.get(id);
              if (!a) byId.set(id, (a = []));
              a.push(w);
            }
          });
        }
      }
    }
  }
  const idx = { byKey, byId };
  memo.set(score, idx);
  return idx;
}

/** Where a Song note is written: start and end of the whole written note, staff and voice. */
export function writtenSpan(score: Score, id: number): { on: number; off: number; staff: Staff; voice: number } | null {
  const ps = writtenIndex(score).byId.get(id);
  if (!ps?.length) return null;
  return { on: ps[0].chordOn, off: ps[0].chordOff, staff: ps[0].staff, voice: ps[0].voice };
}
