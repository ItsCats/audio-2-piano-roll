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
      downbeatIndex: 0,
      confidence: 1,
      source: 'midi',
    },
    duration,
    warnings,
  };
}

export function exportMidi(notes: Note[], pedal: PedalRange[], tempo: TempoInfo, title: string): Uint8Array {
  const midi = new Midi();
  midi.name = title;
  midi.header.setTempo(tempo.bpm);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [tempo.beatsPerBar, 4], measures: 0 });
  midi.header.update();
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
  return midi.toArray();
}
