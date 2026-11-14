/**
 * Songs for the sheet-editing tests: the built-in demo (public domain) and three synthetic MIDI
 * files made here (made-up notes): straight 4/4, a performance with jitter under a flat 120 BPM
 * header (its beats get tracked from the notes), and 6/8 with a pickup.
 */
import { createRequire } from 'node:module';
import type { Song } from '../../src/lib/music/types';
import { parseMidi } from '../../src/lib/music/midi';
import { demoSong, songFromMidi } from '../../src/lib/songs';

const require = createRequire(import.meta.url);
const { Midi } = require('@tonejs/midi');

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Add = (track: 0 | 1, midi: number, time: number, duration: number, velocity?: number) => void;
function midiSong(name: string, bpm: number, ts: [number, number], fill: (add: Add) => void): Song {
  const midi = new Midi();
  midi.header.setTempo(bpm);
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: ts });
  midi.header.update();
  const rh = midi.addTrack();
  rh.name = 'Right Hand';
  const lh = midi.addTrack();
  lh.name = 'Left Hand';
  const tracks = [rh, lh];
  fill((t, m, time, duration, velocity = 0.7) => tracks[t].addNote({ midi: m, time: Math.max(0, time), duration, velocity }));
  const bytes: Uint8Array = midi.toArray();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return songFromMidi(parseMidi(buf), `${name}.mid`, bytes.byteLength);
}

/** 16 bars of 4/4 at 100 BPM: right-hand 8ths and quarters, left-hand half notes and a bass. */
export function straightSong(): Song {
  const q = 0.6;
  return midiSong('straight', 100, [4, 4], (add) => {
    const scale = [0, 2, 4, 5, 7, 9, 11, 12];
    for (let bar = 0; bar < 16; bar++) {
      const t0 = bar * 4 * q;
      for (let i = 0; i < 8; i++) {
        if (bar % 4 === 3 && i >= 4) continue;
        add(0, 67 + scale[(i + bar) % 8], t0 + i * (q / 2), q / 2 * 0.95);
      }
      if (bar % 4 === 3) add(0, 72, t0 + 2 * q, 2 * q * 0.95);
      add(1, 48 + scale[bar % 5], t0, 2 * q * 0.95);
      add(1, 55, t0 + 2 * q, 2 * q * 0.95);
      add(1, 36 + scale[bar % 5], t0, 4 * q * 0.95);
    }
  });
}

/** A played-in performance (timing jitter, rubato) under a flat 120 BPM header. */
export function performedSong(): Song {
  const r = rng(7);
  return midiSong('performed', 120, [4, 4], (add) => {
    let t = 0.3;
    for (let bar = 0; bar < 24; bar++) {
      const beat = 0.68 + 0.05 * Math.sin(bar / 3);
      for (let i = 0; i < 8; i++) {
        const swing = i % 2 ? beat * 0.12 : 0;
        add(0, 64 + ((bar * 3 + i * 2) % 12), t + (i * beat) / 2 + swing + (r() - 0.5) * 0.04, beat * 0.45, 0.5 + r() * 0.3);
      }
      add(1, 45 + (bar % 7), t + (r() - 0.5) * 0.03, beat * 1.9, 0.6);
      add(1, 52 + (bar % 5), t + 2 * beat + (r() - 0.5) * 0.03, beat * 1.9, 0.55);
      t += 4 * beat;
    }
  });
}

/** 6/8 at 120 (quarter) with an 8th-note pickup: 12 bars of 8th runs over dotted-quarter bass. */
export function compoundPickupSong(): Song {
  const e = 0.25; // an 8th at 120 quarters per minute
  return midiSong('sixeight', 120, [6, 8], (add) => {
    // the pickup: one 8th before the first downbeat (the file's beat grid starts at the pickup)
    add(0, 67, 0, e * 0.9);
    for (let bar = 0; bar < 12; bar++) {
      const t0 = e + bar * 6 * e;
      for (let i = 0; i < 6; i++) add(0, 72 + [0, 4, 7, 5, 4, 2][i] - (bar % 3), t0 + i * e, e * 0.9);
      add(1, 48 + (bar % 4) * 2, t0, 3 * e * 0.95);
      add(1, 43 + (bar % 4) * 2, t0 + 3 * e, 3 * e * 0.95);
    }
  });
}

/** compoundPickupSong with the downbeat one 8th in (MIDI files start on a downbeat otherwise). */
function sixEight(): Song {
  const s = compoundPickupSong();
  const beats = s.tempo.beats;
  // beats of a 6/8 file are quarters here: rebuild them as 8ths from 0 with the downbeat on the 2nd
  const e = 0.25;
  const n = Math.ceil(s.duration / e) + 2;
  return { ...s, tempo: { ...s.tempo, beats: Array.from({ length: Math.max(n, beats.length) }, (_, i) => i * e), beatUnit: 8, downbeatIndex: 1 } };
}

export const GOLDEN_SONGS: [string, () => Song][] = [
  ['demo', demoSong],
  ['straight', straightSong],
  ['performed', performedSong],
  ['sixeight', sixEight],
];
