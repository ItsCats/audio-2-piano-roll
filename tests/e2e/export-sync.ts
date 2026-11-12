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
import { AudioSampleSource } from 'mediabunny';

// test-only: the loudest sample handed to the audio encoder (checks the limiter before lossy coding)
let encoderPeak = 0;
const add = AudioSampleSource.prototype.add;
AudioSampleSource.prototype.add = function (sample) {
  const d = new Float32Array(sample.numberOfFrames);
  for (let c = 0; c < sample.numberOfChannels; c++) {
    sample.copyTo(d, { planeIndex: c, format: 'f32-planar' });
    for (const v of d) encoderPeak = Math.max(encoderPeak, Math.abs(v));
  }
  return add.call(this, sample);
};

const NOTE_TIMES = [0.6, 1.37, 2.05, 2.9, 3.62, 4.45, 5.08, 5.93, 6.71, 7.4, 8.26, 9.03, 9.88, 10.6];
const PATTERN_SECONDS = 11.3; // longer songs repeat the pattern
const CLICK_RATE = 44100; // not the export rate, so the export has to resample
export const CLICK_HZ = 6000;

/** A synthetic song of `seconds` length (12 s by default) and its click-track "recording". */
function makeSong(seconds: number) {
  const times: number[] = [];
  for (let base = 0; base < seconds; base += PATTERN_SECONDS) for (const t of NOTE_TIMES) if (base + t < seconds - 1.4) times.push(+(base + t).toFixed(4));
  const notes: Note[] = times.map((t, i) => ({ id: newNoteId(), midi: 40 + ((i * 5) % 12), start: t, dur: 0.18, vel: 0.7, hand: 'L' }));
  const song = buildSong({
    title: 'sync-test',
    source: { kind: 'audio', fileName: 'click.wav', mimeType: 'audio/wav' },
    notes,
    pedal: [],
    tempo: { bpm: 120, beats: [], beatsPerBar: 4, downbeatIndex: 0, confidence: 0, source: 'manual' },
    duration: seconds,
    transcription: { method: 'basic-pitch', estimated: true, warnings: [] },
    hasAudio: true,
    hasPosteriors: false,
  });
  const shown = [...new Set(song.arrangements.hard.notes.map((n) => n.start))].sort((a, b) => a - b);
  return { song, shown, clicks: clickTrack(shown, seconds) };
}

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

async function runExport(name: string, patch: Partial<ExportSettings>, songSeconds = 12) {
  const { song, shown, clicks } = makeSong(songSeconds);
  const settings: ExportSettings = { ...DEFAULT_EXPORT, resolution: 720, fps: 30, quality: 'standard', ...patch };
  const t0 = performance.now();
  encoderPeak = 0;
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
    noteTimes: shown,
    range: exportRange({ song, settings, loop: null }, r.sound),
    lead: settings.leadIn,
    fadeIn: settings.fadeIn,
    fadeOut: settings.fadeOut,
    duration: r.duration,
    sound: r.sound,
    videoCodec: r.videoCodec,
    audioCodec: r.audioCodec,
    bytes: r.blob.size,
    encoderPeak,
    ms: Math.round(performance.now() - t0),
  };
}

Object.assign(window, { runExport, clickHz: CLICK_HZ });
document.getElementById('log')!.textContent = 'ready';
