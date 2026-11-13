// Dev-only harness for tests/e2e/pedal.mjs: the automatic pedal of songs from audio, heard
// through the real piano engine (offline render), with and without it.
import { renderOffline } from '../../src/lib/audio/offlineRender';
import { DEFAULT_AUDIO_SETTINGS } from '../../src/lib/audio/types';
import { buildEvents } from '../../src/lib/audio/events';
import { generateArrangement } from '../../src/lib/music/difficulty';
import type { Note, PedalRange, TempoInfo } from '../../src/lib/music/types';

declare global {
  interface Window {
    runPedal: () => Promise<unknown>;
  }
}

// a choppy "detected" passage: chords every 2 s, a right hand whose notes end far too early,
// then a rest (8-10 s) and one more chord
let id = 1;
const n = (midi: number, start: number, dur: number, hand: 'L' | 'R' = midi < 60 ? 'L' : 'R'): Note => ({ id: id++, midi, start, dur, vel: 0.7, hand });
const notes: Note[] = [];
const chords = [[48, 55], [53, 57], [55, 59], [48, 55]];
const tune = [[72, 76, 79, 76], [77, 81, 77, 72], [74, 79, 83, 79], [76, 79, 72, 76]];
chords.forEach((c, i) => {
  notes.push(n(c[0], i * 2, 0.4), n(c[1], i * 2, 0.4));
  tune[i].forEach((m, k) => notes.push(n(m, i * 2 + k * 0.5, 0.12)));
});
notes.push(n(48, 10, 0.5), n(64, 10, 0.5));
const tempo: TempoInfo = { bpm: 120, beats: Array.from({ length: 24 }, (_, i) => i * 0.5), beatsPerBar: 4, downbeatIndex: 0, confidence: 1, source: 'estimated' };
const duration = 12;

function rms(buf: AudioBuffer, from: number, to: number): number {
  const d = buf.getChannelData(0);
  const a = Math.floor(from * buf.sampleRate);
  const b = Math.min(d.length, Math.floor(to * buf.sampleRate));
  let s = 0;
  for (let i = a; i < b; i++) s += d[i] * d[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

window.runPedal = async () => {
  const medium = generateArrangement('medium', notes, [], tempo, duration, { autoPedal: true });
  const hard = generateArrangement('hard', notes, [], tempo, duration, { autoPedal: true });
  const easy = generateArrangement('easy', notes, [], tempo, duration, { autoPedal: true });
  const settings = { ...DEFAULT_AUDIO_SETTINGS, reverbType: 'off' as const, reverbMix: 0 };
  const render = (pedal: PedalRange[]) => renderOffline({ notes: hard.notes, pedal, settings, start: 0, end: duration, rate: 1, sampleRate: 44100, tail: 0.5 });
  const dry = await render([]);
  const wet = await render(hard.pedal);
  // between the short right-hand notes (no key held) and inside the rest
  const gaps: Array<[number, number]> = [];
  for (let bar = 0; bar < 4; bar++) for (let k = 0; k < 4; k++) gaps.push([bar * 2 + k * 0.5 + 0.32, bar * 2 + k * 0.5 + 0.48]);
  const gapDry = gaps.reduce((s, [a, b]) => s + rms(dry, a, b), 0) / gaps.length;
  const gapWet = gaps.reduce((s, [a, b]) => s + rms(wet, a, b), 0) / gaps.length;
  return {
    pedal: { easy: easy.pedal.length, medium: medium.pedal.length, hard: hard.pedal.length },
    pedalEvents: buildEvents(hard.notes, hard.pedal, { L: true, R: true }).filter((e) => e.kind === 'pedal').length,
    gapRms: { dry: gapDry, wet: gapWet, ratio: gapWet / Math.max(1e-9, gapDry) },
    restRms: { dry: rms(dry, 9.2, 9.9), wet: rms(wet, 9.2, 9.9) },
    ranges: hard.pedal,
  };
};
document.getElementById('log')!.textContent = 'ready';
