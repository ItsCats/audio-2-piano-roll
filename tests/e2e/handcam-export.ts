// Hands video export harness (driven by handcam-export.mjs): a song with exactly known notes plus the
// synthetic hands video (tests/e2e/handcam-video.mjs) is exported with the video at the bottom, and the
// geometry the export used is returned so the runner can check the lanes against the real keys.
import { buildSong } from '../../src/lib/songs';
import { newNoteId } from '../../src/lib/music/cleanup';
import { DEFAULT_AUDIO_SETTINGS } from '../../src/lib/audio/types';
import { DEFAULT_VISUAL } from '../../src/lib/render/settings';
import { DEFAULT_EXPORT, outputSize, type ExportSettings } from '../../src/lib/export/types';
import { exportVideo } from '../../src/lib/export/videoExport';
import { calibratedLayout, defaultCalibration, outputGeometry, noteSpan } from '../../src/lib/handcam/calibration';
import { probeVideo, handVideoFrom } from '../../src/lib/handcam/media';
import { watermarkBand, watermarkLayout } from '../../src/lib/watermark/layout';
import { canvasMeasure } from '../../src/lib/watermark/draw';
import { DEFAULT_WATERMARK, type WatermarkSettings } from '../../src/lib/watermark/types';
import type { Note } from '../../src/lib/music/types';
import type { HandsLayout, KeyboardCalibration } from '../../src/lib/handcam/types';
import { DEFAULT_LOOK, DEFAULT_TITLE_CARD, type TitleCardSettings } from '../../src/lib/render/titleCard/types';

declare global {
  interface Window {
    saveChunk(name: string, b64: string): Promise<void>;
    getVideo(name: string): Promise<string>;
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

async function loadVideo(name: string): Promise<File> {
  const b64 = await window.getVideo(name);
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new File([u], name, { type: 'video/mp4' });
}

interface RunOpts {
  video: string;
  notes: { start: number; dur: number; midi: number; vel: number }[];
  duration: number;
  quad: [number, number][];
  offset: number;
  layout: HandsLayout;
  sound: ExportSettings['sound'];
  watermark?: Partial<WatermarkSettings>;
  patch?: Partial<ExportSettings>;
  cal?: Partial<KeyboardCalibration>;
  /** title page length (s) */
  title?: number;
}

async function runExport(name: string, o: RunOpts) {
  const file = await loadVideo(o.video);
  const notes: Note[] = o.notes.map((n) => ({ id: newNoteId(), midi: n.midi, start: n.start, dur: n.dur, vel: n.vel, hand: n.midi < 60 ? 'L' : 'R' }));
  const song = buildSong({
    title: 'hands-test',
    source: { kind: 'midi', fileName: 'x.mid' },
    notes,
    pedal: [],
    tempo: { bpm: 120, beats: [], beatsPerBar: 4, downbeatIndex: 0, confidence: 0, source: 'manual' },
    duration: o.duration,
    transcription: { method: 'midi-file', estimated: false, warnings: [] },
    hasAudio: false,
    hasPosteriors: false,
  });
  const probe = await probeVideo(file);
  const cal = defaultCalibration({ corners: o.quad, ...(o.cal ?? {}) });
  song.handVideo = handVideoFrom(file, probe, { store: 'handcam', offset: o.offset, calibration: cal });
  const settings: ExportSettings = { ...DEFAULT_EXPORT, resolution: 720, fps: 30, format: 'mp4', quality: 'standard', range: 'full', leadIn: 1, fadeIn: 0, fadeOut: 0, handsLayout: o.layout, sound: o.sound, ...(o.patch ?? {}) };
  const watermark: WatermarkSettings | undefined = o.watermark ? { ...DEFAULT_WATERMARK, enabled: true, text: 'youtube.com/yourname', ...o.watermark } : undefined;
  const t0 = performance.now();
  const phases = new Set<string>();
  const tc: TitleCardSettings = { ...DEFAULT_TITLE_CARD, enabled: true, duration: o.title ?? 3, look: { ...DEFAULT_LOOK, preset: 'floral' } };
  const warnings: string[] = [];
  const r = await exportVideo({
    titleCard: o.title ? { settings: tc, text: { title: 'Hands Test', composer: 'Piano2Vision' }, onWarning: (m) => warnings.push(m) } : undefined,
    song,
    difficulty: 'hard',
    visual: { ...DEFAULT_VISUAL, effects: { ...DEFAULT_VISUAL.effects } },
    audio: { ...DEFAULT_AUDIO_SETTINGS, reverbType: 'off', mechanicalNoise: false },
    settings,
    loop: null,
    loadHandVideo: async () => file,
    watermark,
    onProgress: (p) => phases.add(p.phase),
  });
  await send(name, r.blob);
  // the geometry the export used
  const { width, height } = outputSize(settings);
  const band = watermark ? watermarkBand(watermark, width, height) : 0;
  const g = outputGeometry(width, height, cal, { wmBand: band, song: noteSpan(notes) });
  const L = calibratedLayout(cal, g);
  const lanes: Record<number, number> = {};
  for (const n of notes) lanes[n.midi] = L.keys[n.midi]!.x + L.keys[n.midi]!.w / 2;
  let wm = null;
  if (watermark) {
    const c = new OffscreenCanvas(8, 8).getContext('2d')!;
    const { ensureFont } = await import('../../src/lib/render/titleCard/fonts');
    await ensureFont(watermark.font, 600, 'X');
    wm = watermarkLayout(watermark, width, height, canvasMeasure(c), { band }).bbox;
  }
  return { name, warnings, width, height, duration: r.duration, videoCodec: r.videoCodec, audioCodec: r.audioCodec, bytes: r.blob.size, ms: Math.round(performance.now() - t0), geom: g, lanes, wm, probe, phases: [...phases], lead: settings.leadIn };
}

Object.assign(window, { runExport });
document.getElementById('log')!.textContent = 'ready';
