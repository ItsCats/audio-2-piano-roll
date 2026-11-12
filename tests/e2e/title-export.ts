// Export with a title page / end card (driven by title-export.mjs): a synthetic song with notes at
// 1.0 s and 2.0 s is exported with and without the cards so the runner can compare the files.
import { buildSong } from '../../src/lib/songs';
import { newNoteId } from '../../src/lib/music/cleanup';
import { DEFAULT_AUDIO_SETTINGS } from '../../src/lib/audio/types';
import { DEFAULT_VISUAL } from '../../src/lib/render/settings';
import { DEFAULT_EXPORT, type ExportSettings } from '../../src/lib/export/types';
import { exportVideo } from '../../src/lib/export/videoExport';
import { DEFAULT_LOOK, DEFAULT_TITLE_CARD, type TitleCardSettings, type TitlePresetId } from '../../src/lib/render/titleCard/types';
import type { Note } from '../../src/lib/music/types';

const notes: Note[] = [1.0, 2.0].map((t, i) => ({ id: newNoteId(), midi: 60 + i * 7, start: t, dur: 0.4, vel: 0.8, hand: 'R' }));
const song = buildSong({
  title: 'offset-test',
  source: { kind: 'midi', fileName: 'x.mid' },
  notes,
  pedal: [],
  tempo: { bpm: 120, beats: [], beatsPerBar: 4, downbeatIndex: 0, confidence: 0, source: 'manual' },
  duration: 3,
  transcription: { method: 'midi-file', estimated: false, warnings: [] },
  hasAudio: false,
  hasPosteriors: false,
});

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

async function runExport(name: string, opts: { title?: number; end?: number; preset?: TitlePresetId; patch?: Partial<ExportSettings> }) {
  const settings: ExportSettings = { ...DEFAULT_EXPORT, resolution: 720, fps: 30, format: 'mp4', quality: 'standard', range: 'full', leadIn: 0, fadeIn: 0, fadeOut: 0, ...(opts.patch ?? {}) };
  const tc: TitleCardSettings = {
    ...DEFAULT_TITLE_CARD,
    enabled: !!opts.title,
    duration: opts.title ?? 4,
    look: { ...DEFAULT_LOOK, preset: opts.preset ?? 'floral' },
    end: { ...DEFAULT_TITLE_CARD.end, enabled: !!opts.end, duration: opts.end ?? 4 },
  };
  const warnings: string[] = [];
  const t0 = performance.now();
  const r = await exportVideo({
    song,
    difficulty: 'hard',
    visual: DEFAULT_VISUAL,
    audio: { ...DEFAULT_AUDIO_SETTINGS, reverbType: 'off', mechanicalNoise: false },
    settings,
    loop: null,
    titleCard: opts.title || opts.end ? { settings: tc, text: { title: 'Clair de Lune', subtitle: 'Suite Bergamasque', composer: 'Debussy', credit: 'Piano2Vision', small: 'For you' }, onWarning: (m) => warnings.push(m) } : undefined,
  });
  await send(name, r.blob);
  return { name, duration: r.duration, videoCodec: r.videoCodec, audioCodec: r.audioCodec, bytes: r.blob.size, ms: Math.round(performance.now() - t0), warnings };
}

Object.assign(window, { runExport });
document.getElementById('log')!.textContent = 'ready';
