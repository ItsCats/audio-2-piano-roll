// Video export with the song's "original recording": exports a synthetic song whose recording is a
// click track exactly on its notes, so the runner (export-sync.mjs) can check the clicks land where
// the notes are shown. Synthetic audio only.
import { buildSong } from '../../src/lib/songs';
import { newNoteId } from '../../src/lib/music/cleanup';
import { WavWriter } from '../../src/lib/audio/wav';
import { DEFAULT_AUDIO_SETTINGS } from '../../src/lib/audio/types';
import { DEFAULT_VISUAL } from '../../src/lib/render/settings';
import { DEFAULT_EXPORT, type ExportSettings } from '../../src/lib/export/types';
import { exportRange, exportVideo } from '../../src/lib/export/videoExport';
import type { Note } from '../../src/lib/music/types';

const NOTE_TIMES = [0.6, 1.37, 2.05, 2.9, 3.62, 4.45, 5.08, 5.93, 6.71, 7.4, 8.26, 9.03, 9.88, 10.6];
const CLICK_RATE = 44100; // not the export rate, so the export has to resample
export const CLICK_HZ = 6000;

const notes: Note[] = NOTE_TIMES.map((t, i) => ({ id: newNoteId(), midi: 40 + ((i * 5) % 12), start: t, dur: 0.18, vel: 0.7, hand: 'L' }));
const song = buildSong({
  title: 'sync-test',
  source: { kind: 'audio', fileName: 'click.wav', mimeType: 'audio/wav' },
  notes,
  pedal: [],
  tempo: { bpm: 120, beats: [], beatsPerBar: 4, downbeatIndex: 0, confidence: 0, source: 'manual' },
  duration: 12,
  transcription: { method: 'basic-pitch', estimated: true, warnings: [] },
  hasAudio: true,
  hasPosteriors: false,
});
const shown = [...new Set(song.arrangements.hard.notes.map((n) => n.start))].sort((a, b) => a - b);

/** A 3 ms decaying 6 kHz burst exactly at each shown note start, silence elsewhere. */
function clickTrack(times: number[], seconds: number): Blob {
  const len = Math.round(seconds * CLICK_RATE);
  const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: CLICK_RATE });
  const l = buf.getChannelData(0);
  const burst = Math.round(0.003 * CLICK_RATE);
  for (const t of times) {
    // the burst's first sample sits at the note time (rounded to the nearest 44.1 kHz sample)
    const f0 = Math.round(t * CLICK_RATE);
    for (let i = 0; i < burst && f0 + i < len; i++) l[f0 + i] = 0.8 * Math.cos((2 * Math.PI * CLICK_HZ * i) / CLICK_RATE) * Math.exp(-i / (burst / 4));
  }
  buf.getChannelData(1).set(l);
  const w = new WavWriter(CLICK_RATE, 2);
  w.append(buf);
  return w.finish();
}
const clicks = clickTrack(shown, 12);

declare global {
  interface Window {
    saveChunk(name: string, b64: string): Promise<void>;
  }
}

async function send(name: string, blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const step = 1 << 20;
  for (let i = 0; i < bytes.length; i += step) {
    let s = '';
    const part = bytes.subarray(i, i + step);
    for (let j = 0; j < part.length; j += 0x8000) s += String.fromCharCode(...part.subarray(j, j + 0x8000));
    await window.saveChunk(name, btoa(s));
  }
}

async function runExport(name: string, patch: Partial<ExportSettings>) {
  const settings: ExportSettings = { ...DEFAULT_EXPORT, resolution: 720, fps: 30, quality: 'standard', ...patch };
  const t0 = performance.now();
  const r = await exportVideo({
    song,
    difficulty: 'hard',
    visual: DEFAULT_VISUAL,
    audio: { ...DEFAULT_AUDIO_SETTINGS, reverbType: 'off', mechanicalNoise: false, originalVolume: 0 },
    settings,
    loop: null,
    loadOriginal: async () => clicks,
  });
  await send(name, r.blob);
  return {
    name,
    range: exportRange({ song, settings, loop: null }),
    lead: settings.leadIn,
    fadeIn: settings.fadeIn,
    fadeOut: settings.fadeOut,
    duration: r.duration,
    sound: r.sound,
    videoCodec: r.videoCodec,
    audioCodec: r.audioCodec,
    bytes: r.blob.size,
    ms: Math.round(performance.now() - t0),
  };
}

Object.assign(window, { runExport, noteTimes: shown, clickHz: CLICK_HZ });
document.getElementById('log')!.textContent = 'ready';
