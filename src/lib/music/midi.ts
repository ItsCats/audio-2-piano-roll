import { Midi } from '@tonejs/midi';
import type { Note, PedalRange, TempoInfo } from './types';
import { assignHands } from './hands';
import { newNoteId, sortNotes, songDuration } from './cleanup';

export interface ParsedMidi {
  title?: string;
  notes: Note[];
  pedal: PedalRange[];
  tempo: TempoInfo;
  duration: number;
  warnings: string[];
  /** The hands come from the file (named hand tracks or the two-staff layout), not from assignHands. */
  handsKnown: boolean;
}

const handFromName = (name: string): Note['hand'] | null => {
  const n = name.toLowerCase();
  if (/\b(left|lh|l\.h\.|bass)\b|left hand|links/.test(n)) return 'L';
  if (/\b(right|rh|r\.h\.|treble|melody)\b|right hand|rechts/.test(n)) return 'R';
  return null;
};

export function parseMidi(data: ArrayBuffer): ParsedMidi {
  const midi = new Midi(data);
  const warnings: string[] = [];
  const tracks = midi.tracks.filter((t) => t.notes.length > 0 && t.channel !== 9);
  if (midi.tracks.some((t) => t.channel === 9 && t.notes.length)) warnings.push('Drum track ignored.');
  if (!tracks.length) throw new Error('This MIDI file contains no playable notes.');

  // hand hints: named tracks, or the classic two-staff piano layout (track 1 = RH, track 2 = LH)
  const named = tracks.map((t) => handFromName(t.name || t.instrument?.name || ''));
  const twoStaff = tracks.length === 2 && (() => {
    const avg = (t: (typeof tracks)[number]) => t.notes.reduce((s, n) => s + n.midi, 0) / t.notes.length;
    return avg(tracks[0]) > avg(tracks[1]) + 5;
  })();

  let notes: Note[] = [];
  tracks.forEach((t, ti) => {
    const hint = named[ti] ?? (twoStaff ? (ti === 0 ? 'R' : 'L') : null);
    for (const n of t.notes) {
      if (n.midi < 21 || n.midi > 108) continue;
      notes.push({
        id: newNoteId(),
        midi: n.midi,
        start: n.time,
        dur: Math.max(0.02, n.duration),
        vel: n.velocity,
        hand: hint ?? 'R',
      });
    }
  });
  const hintsKnown = tracks.every((_, i) => named[i] !== null) || twoStaff;
  const duration = Math.max(songDuration(notes), midi.duration);
  if (!hintsKnown) notes = assignHands(notes, duration);

  // sustain pedal (CC64) from any track
  const pedalEvents: { time: number; down: boolean }[] = [];
  for (const t of midi.tracks) {
    const cc = t.controlChanges[64] ?? [];
    for (const c of cc) pedalEvents.push({ time: c.time, down: c.value >= 0.5 });
  }
  pedalEvents.sort((a, b) => a.time - b.time);
  const pedal: PedalRange[] = [];
  let downAt: number | null = null;
  for (const e of pedalEvents) {
    if (e.down && downAt === null) downAt = e.time;
    else if (!e.down && downAt !== null) {
      if (e.time - downAt > 0.01) pedal.push({ start: downAt, end: e.time });
      downAt = null;
    }
  }
  if (downAt !== null) pedal.push({ start: downAt, end: duration });

  // tempo map -> beat times
  const ppq = midi.header.ppq;
  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  const ts = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
  const beatTicks = ppq * (4 / (ts[1] || 4));
  const beats: number[] = [];
  for (let b = 0; ; b++) {
    const t = midi.header.ticksToSeconds(b * beatTicks);
    beats.push(t);
    if (t > duration + 2 || b > 20000) break;
  }
  return {
    title: midi.name || undefined,
    notes: sortNotes(notes),
    pedal,
    tempo: {
      bpm: Math.round(bpm * 10) / 10,
      beats,
      beatsPerBar: ts[0] || 4,
      ...(ts[1] === 2 || ts[1] === 8 ? { beatUnit: ts[1] as 2 | 8 } : {}),
      downbeatIndex: 0,
      confidence: 1,
      source: 'midi',
    },
    duration,
    warnings,
    handsKnown: hintsKnown,
  };
}

/** Key, time-signature and tempo changes (in song seconds) written as MIDI meta events (lib/sheet/midiMeta.ts). */
export interface MidiMeta {
  keys: { time: number; fifths: number; mode: 'major' | 'minor' }[];
  meters: { time: number; beatsPerBar: number; beatUnit: number }[];
  /** Quarter notes per minute from that time on. */
  tempos: { time: number; qpm: number }[];
}

const KEY_NAMES = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];

export function exportMidi(notes: Note[], pedal: PedalRange[], tempo: TempoInfo, title: string, meta?: MidiMeta): Uint8Array {
  const midi = new Midi();
  midi.name = title;
  midi.header.setTempo(tempo.bpm);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [tempo.beatsPerBar, tempo.beatUnit ?? 4], measures: 0 });
  midi.header.update();
  if (meta) {
    const h = midi.header;
    // tempo changes one by one: each one's tick follows from the tempos before it
    for (const t of [...meta.tempos].sort((a, b) => a.time - b.time)) {
      if (!(t.qpm > 0) || !Number.isFinite(t.time)) continue;
      const ticks = h.secondsToTicks(t.time);
      if (ticks <= 0) h.tempos = h.tempos.filter((x) => x.ticks > 0);
      h.tempos = h.tempos.filter((x) => x.ticks !== ticks);
      h.tempos.push({ ticks, bpm: t.qpm });
      h.tempos.sort((a, b) => a.ticks - b.ticks);
      h.update();
    }
    for (const m of meta.meters) {
      const ticks = h.secondsToTicks(m.time);
      h.timeSignatures = h.timeSignatures.filter((x) => x.ticks !== ticks);
      h.timeSignatures.push({ ticks, timeSignature: [m.beatsPerBar, m.beatUnit] });
    }
    h.timeSignatures.sort((a, b) => a.ticks - b.ticks);
    for (const k of meta.keys) {
      const ticks = h.secondsToTicks(k.time);
      h.keySignatures = h.keySignatures.filter((x) => x.ticks !== ticks);
      h.keySignatures.push({ ticks, key: KEY_NAMES[k.fifths + 7] ?? 'C', scale: k.mode });
    }
    h.keySignatures.sort((a, b) => a.ticks - b.ticks);
    h.update();
  }
  const rh = midi.addTrack();
  rh.name = 'Right Hand';
  rh.channel = 0;
  const lh = midi.addTrack();
  lh.name = 'Left Hand';
  lh.channel = 0;
  for (const n of sortNotes(notes)) {
    (n.hand === 'L' ? lh : rh).addNote({
      midi: n.midi,
      time: n.start,
      duration: n.dur,
      velocity: Math.max(0.01, Math.min(1, n.vel)),
    });
  }
  for (const p of pedal) {
    rh.addCC({ number: 64, value: 1, time: p.start });
    rh.addCC({ number: 64, value: 0, time: p.end });
  }
  const bytes = midi.toArray();
  return meta?.keys.length ? fixKeySignatures(bytes) : bytes;
}

/**
 * @tonejs/midi 2.0.28 writes a key signature's sharps/flats byte 14 too high (it adds 7 to an index
 * that is already offset by 7), so the file would read back wrong everywhere. Walks the first
 * track (tempo, time and key events only) and puts the right value in each FF 59 event.
 */
function fixKeySignatures(bytes: Uint8Array): Uint8Array {
  const b = new Uint8Array(bytes);
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  let i = 8 + u32(4); // after the MThd chunk
  if (String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]) !== 'MTrk') return bytes;
  const end = i + 8 + u32(i + 4);
  i += 8;
  const varint = () => {
    let v = 0;
    for (let k = 0; k < 4 && i < end; k++) {
      const c = b[i++];
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return v;
  };
  while (i < end) {
    varint(); // delta time
    const status = b[i++];
    if (status === 0xff) {
      const type = b[i++];
      const len = varint();
      if (type === 0x59 && len === 2) {
        // every key event here was written by tonejs (7…21 for −7…7)
        b[i] = (((b[i] << 24) >> 24) - 14) & 0xff;
      }
      i += len;
    } else if (status === 0xf0 || status === 0xf7) i += varint();
    else return b; // channel messages: not in the tempo track
  }
  return b;
}
