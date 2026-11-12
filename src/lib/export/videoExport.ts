/**
 * Piano-roll video rendering.
 *
 * Primary path (Chrome, Edge, Firefox 130+, Safari 16.4+): frame-exact, faster-or-slower-
 * than-real-time rendering with WebCodecs via mediabunny.
 *   1. Audio is rendered offline with the same piano engine (chunked, bounded memory)
 *      and encoded to AAC (MP4; WASM encoder fallback) or Opus (WebM).
 *   2. Each video frame is drawn by the same renderer as the live Studio at an exact
 *      timestamp (frame i ↔ t = i / fps), so audio and video are locked by construction.
 *   3. The muxed file is streamed to the Origin Private File System when available, so
 *      long exports don't have to fit in RAM.
 *
 * Optional original recording (songs imported from audio): decoded once at 48 kHz and added
 * sample by sample at the song time the picture shows (src/lib/export/originalMix.ts). Only at
 * 100 % speed; it is dropped before the video frames are drawn.
 *
 * Fallback (no WebCodecs): real-time capture with MediaRecorder (WebM), piano only.
 */
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
  canEncodeAudio,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import type { Difficulty, Song } from '../music/types';
import type { VisualSettings } from '../render/settings';
import type { AudioSettings } from '../audio/types';
import { PianoRollRenderer } from '../render/renderer';
import { renderOfflineChunks } from '../audio/offlineRender';
import { PianoEngine } from '../audio/pianoEngine';
import { buildEvents } from '../audio/events';
import { getAudio, getMedia } from '../storage/db';
import { decodeToRate } from '../transcription/decode';
import { isMemoryConstrained, pageDeviceInfo } from '../transcription/backendChoice';
import { outputSize, type ExportSettings, type ExportSound } from './types';
import { STEP_TIMEOUT_MS, abortError, finalizeTimeoutMs, guardStep } from './guard';
import {
  EXPORT_SAMPLE_RATE,
  createLimiter,
  effectiveRate,
  effectiveSound,
  exportTimeline,
  fadeGain,
  flushTinyInPlace,
  mixOriginal,
  neededSpan,
  originalGain,
  shouldDownmix,
  trimOriginal,
  type ExportTimeline,
  type OriginalSource,
} from './originalMix';

export interface ExportProgress {
  phase: 'preparing' | 'original' | 'audio' | 'video' | 'finalizing';
  fraction: number; // overall 0..1
  framesDone?: number;
  framesTotal?: number;
  renderFps?: number;
  etaSeconds?: number;
}

export interface ExportResult {
  blob: Blob;
  mime: string;
  extension: 'mp4' | 'webm';
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  duration: number;
  method: 'webcodecs' | 'mediarecorder';
  /** what the sound track holds */
  sound: ExportSound;
}

export interface ExportJob {
  song: Song;
  difficulty: Difficulty;
  visual: VisualSettings;
  audio: AudioSettings;
  settings: ExportSettings;
  loop: { start: number; end: number } | null;
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
  /** loads the song's original recording (default: from storage); a test hook */
  loadOriginal?: () => Promise<Blob | undefined>;
}

/** What the exported sound track holds for this job (piano only without WebCodecs or a recording). */
export function jobSound(job: Pick<ExportJob, 'song' | 'settings'>) {
  return effectiveSound(job.settings, { hasOriginal: !!job.song.hasAudio, webCodecs: webCodecsAvailable() });
}

export { STALL_MESSAGE } from './guard';
export const NO_ORIGINAL_MESSAGE = 'The original recording for this song is no longer saved. Choose “Piano” to export without it.';
export const ORIGINAL_DECODE_MESSAGE = 'Couldn’t load the original song on this device. Choose “Piano” to export without it.';
/**
 * Best effort: stops a stuck audio encoder (the WASM AAC encoder runs in a worker that would keep
 * running until the tab closes). Uses mediabunny internals, so every step is optional.
 */
function forceStopAudioEncoder(src: AudioSampleSource): void {
  try {
    const enc = (src as unknown as { _encoder?: { customEncoder?: { worker?: { terminate?: () => void } | null } | null; encoder?: { state?: string; close?: () => void } | null } })._encoder;
    enc?.customEncoder?.worker?.terminate?.();
    if (enc?.encoder && enc.encoder.state !== 'closed') enc.encoder.close?.();
  } catch {
    /* ignore */
  }
}

/** output.cancel() waits for encoders to flush; a stuck one never does, so don't wait long */
async function cancelOutput(output: Output): Promise<void> {
  await Promise.race([output.cancel().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
}

/** Decodes the original recording at the export rate and keeps only the part this export can hear. */
async function loadOriginalSource(job: ExportJob, range: { start: number; end: number }, tl: ExportTimeline): Promise<OriginalSource> {
  let blob: Blob | undefined;
  try {
    blob = await (job.loadOriginal ?? (() => getAudio(job.song.id)))();
  } catch {
    blob = undefined;
  }
  if (!blob) throw new Error(NO_ORIGINAL_MESSAGE);
  if (job.signal?.aborted) throw abortError();
  let buffer: AudioBuffer | null;
  try {
    buffer = await decodeToRate(blob, tl.sr);
  } catch (e) {
    throw new Error(ORIGINAL_DECODE_MESSAGE, { cause: e });
  }
  blob = undefined;
  const device = pageDeviceInfo();
  const mono = shouldDownmix(buffer.duration, buffer.numberOfChannels, !!device && isMemoryConstrained(device));
  const src = trimOriginal(buffer, neededSpan(range, tl.lead, tl.tail, tl.rate), { mono });
  buffer = null; // only the part this export hears is kept
  return src;
}

export function webCodecsAvailable(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

/**
 * Song-time range shown in the video. `sound` is what the sound track holds: with the original
 * recording, "Full song" starts at 0 so a long intro before the first note is kept.
 */
export function exportRange(job: Pick<ExportJob, 'song' | 'settings' | 'loop'>, sound: ExportSound = 'piano'): { start: number; end: number } {
  const s = job.settings;
  if (s.range === 'loop' && job.loop) return { start: job.loop.start, end: job.loop.end };
  if (s.range === 'custom') {
    const start = Math.max(0, Math.min(s.customStart, job.song.duration));
    return { start, end: Math.max(start + 1, Math.min(s.customEnd, job.song.duration)) };
  }
  if (sound !== 'piano') return { start: 0, end: job.song.duration };
  // full song: trim leading silence
  const notes = job.song.arrangements.hard.notes;
  const first = notes.length ? Math.min(...notes.slice(0, 50).map((n) => n.start)) : 0;
  return { start: Math.max(0, first - 0.25), end: job.song.duration };
}

/** Visual settings used for export, derived from the Studio look plus export options. */
export function exportVisual(job: Pick<ExportJob, 'visual' | 'settings'>): VisualSettings {
  const v = job.visual;
  const s = job.settings;
  const range = s.keyboardRange === 'match' ? v.range : s.keyboardRange;
  // vertical videos have little width: fewer, wider keys look much better
  const portraitRange = s.orientation === 'portrait' && range === 'full' ? 'auto' : range;
  return {
    ...v,
    range: portraitRange,
    showKeyboard: s.showKeyboard,
    keyboardHeight: s.orientation === 'portrait' ? Math.min(v.keyboardHeight, 0.12) : v.keyboardHeight,
  };
}

function bitrateFor(width: number, height: number, fps: number, quality: 'standard' | 'high'): number {
  // piano-roll content (flat colours, smooth motion) compresses well; these are generous
  const pixels = width * height;
  const base = pixels * fps * (quality === 'high' ? 0.075 : 0.045);
  return Math.round(Math.min(40e6, Math.max(2e6, base)));
}

async function pickCodecs(format: 'mp4' | 'webm', width: number, height: number, bitrate: number) {
  const video: VideoCodec[] = format === 'mp4' ? ['avc', 'hevc', 'vp9', 'av1'] : ['vp9', 'vp8', 'av1'];
  const videoCodec = await getFirstEncodableVideoCodec(video, { width, height, bitrate });
  let audioCodec: AudioCodec | null = null;
  if (format === 'mp4') {
    if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192e3 })) audioCodec = 'aac';
    else {
      // register the WASM AAC encoder and try again
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
      registerAacEncoder();
      if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 192e3 })) audioCodec = 'aac';
    }
    if (!audioCodec && (await canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000 }))) audioCodec = 'opus';
  } else if (await canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000 })) audioCodec = 'opus';
  return { videoCodec, audioCodec };
}

async function makeTarget(ext: string): Promise<{ target: BufferTarget | StreamTarget; getBlob: (mime: string) => Promise<Blob>; cleanup: () => Promise<void> }> {
  // Stream to the Origin Private File System so large videos don't live in memory.
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (root) {
      const name = `export-${Date.now()}.${ext}`;
      const handle = await root.getFileHandle(name, { create: true });
      const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      const target = new StreamTarget(writable as unknown as WritableStream, { chunked: true });
      return {
        target,
        getBlob: async (mime) => {
          const f = await handle.getFile();
          return new Blob([f], { type: mime });
        },
        cleanup: async () => {
          try {
            await root.removeEntry(name);
          } catch {
            /* ignore */
          }
        },
      };
    }
  } catch {
    /* OPFS unavailable → memory */
  }
  const target = new BufferTarget();
  return {
    target,
    getBlob: async (mime) => new Blob([target.buffer!], { type: mime }),
    cleanup: async () => {},
  };
}

/** Old OPFS export files are removed on startup (exports are downloaded, not kept). */
export async function cleanupExportFiles(): Promise<void> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return;
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.startsWith('export-')) await root.removeEntry(name).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

interface BackgroundProvider {
  kind: 'image' | 'video' | null;
  frameAt(t: number): Promise<CanvasImageSource | null>;
  dispose(): void;
}

async function backgroundProvider(visual: VisualSettings, timestamps: () => Iterable<number>): Promise<BackgroundProvider> {
  const bg = visual.background;
  const none: BackgroundProvider = { kind: null, frameAt: async () => null, dispose: () => {} };
  if (!bg.mediaId || (bg.kind !== 'image' && bg.kind !== 'video')) return none;
  const item = await getMedia(bg.mediaId);
  if (!item) return none;
  if (item.kind === 'image') {
    const bmp = await createImageBitmap(item.blob);
    return { kind: 'image', frameAt: async () => bmp, dispose: () => bmp.close() };
  }
  const input = new Input({ source: new BlobSource(item.blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) return none;
  const dur = await track.computeDuration();
  const sink = new CanvasSink(track, { width: Math.min(1920, track.displayWidth), height: Math.min(1080, track.displayHeight), fit: 'contain' });
  // decode frames sequentially for the exact (looped) timestamps we need
  const gen = sink.canvasesAtTimestamps(
    (function* () {
      for (const t of timestamps()) yield dur > 0 ? t % dur : 0;
    })(),
  );
  let last: CanvasImageSource | null = null;
  return {
    kind: 'video',
    frameAt: async () => {
      const r = await gen.next();
      if (!r.done && r.value) last = r.value.canvas as CanvasImageSource;
      return last;
    },
    dispose: () => void gen.return(undefined),
  };
}

/** Loads the user's uploaded decal image (decal.source === 'image') as an ImageBitmap. */
async function loadDecalBitmap(visual: VisualSettings): Promise<ImageBitmap | null> {
  const d = visual.decal;
  if (d.source !== 'image' || !d.mediaId) return null;
  try {
    const item = await getMedia(d.mediaId);
    if (!item || item.kind !== 'image') return null;
    return await createImageBitmap(item.blob);
  } catch {
    return null; // a broken/missing decal shouldn't fail the whole export
  }
}

function applyDecal(renderer: PianoRollRenderer, bmp: ImageBitmap | null): void {
  if (bmp) renderer.setDecalImage(bmp, bmp.width, bmp.height);
  else renderer.setDecalImage(null);
}

export async function exportVideo(job: ExportJob): Promise<ExportResult> {
  if (!webCodecsAvailable()) return exportWithMediaRecorder(job);
  const { song, settings: s, signal } = job;
  const progress = (p: ExportProgress) => job.onProgress?.(p);
  progress({ phase: 'preparing', fraction: 0 });
  const { width, height } = outputSize(s);
  const fps = s.fps;
  const sound = jobSound(job);
  const range = exportRange(job, sound);
  const rate = effectiveRate(s, sound);
  const sr = EXPORT_SAMPLE_RATE;
  const tl = exportTimeline(s, range, rate, sr);
  const { lead, tail, duration } = tl;
  const totalFrames = Math.ceil(duration * fps);
  const bitrate = bitrateFor(width, height, fps, s.quality);

  const { videoCodec, audioCodec } = await pickCodecs(s.format, width, height, bitrate);
  if (!videoCodec) throw new Error(`This browser cannot encode ${s.format.toUpperCase()} video at ${width}×${height}. Try WebM or a lower resolution.`);
  if (!audioCodec) throw new Error('This browser cannot encode audio for this format. Try WebM.');

  // the original recording is decoded before the output file exists, so a failure leaves nothing behind
  let orig: OriginalSource | null = null;
  if (sound !== 'piano') {
    progress({ phase: 'original', fraction: 0.005 });
    orig = await loadOriginalSource(job, range, tl);
    if (signal?.aborted) throw abortError();
  }
  const origGain = originalGain(s, job.audio.originalVolume);

  const ext = s.format;
  const mime = s.format === 'mp4' ? 'video/mp4' : 'video/webm';
  const { target, getBlob, cleanup } = await makeTarget(ext);
  const output = new Output({
    format: s.format === 'mp4' ? new Mp4OutputFormat({ fastStart: target instanceof BufferTarget ? 'in-memory' : false }) : new WebMOutputFormat(),
    target,
  });

  const canvas = new OffscreenCanvas(width, height);
  const visual = exportVisual(job);
  const renderer = new PianoRollRenderer(canvas, visual);
  renderer.resize(width, height);
  const arr = song.arrangements[job.difficulty];
  renderer.setNotes(arr.notes, arr.pedal, song.tempo, song.key);

  const videoSource = new CanvasSource(canvas, {
    codec: videoCodec,
    bitrate,
    keyFrameInterval: 2,
    latencyMode: 'quality',
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  const audioSource = new AudioSampleSource({ codec: audioCodec, bitrate: 192e3 });
  output.addAudioTrack(audioSource);
  await output.start();

  let bg: BackgroundProvider | null = null;
  let decal: ImageBitmap | null = null;
  try {
    decal = await loadDecalBitmap(visual);
    applyDecal(renderer, decal);
    // ---------- audio ----------
    const audioWeight = 0.18;
    const limiter = orig ? createLimiter(sr) : null;
    // planar stereo block at output frame `outFrame0`, with the original mixed in when used
    const addBlock = async (data: Float32Array, n: number, outFrame0: number, timestamp: number) => {
      const chans = [data.subarray(0, n), data.subarray(n, 2 * n)];
      if (orig) {
        mixOriginal(chans, outFrame0, n, orig, tl, origGain);
        limiter!.process(chans);
      }
      // the WASM AAC encoder can stall forever on some near-silent content; values this small are inaudible
      if (audioCodec === 'aac') for (const c of chans) flushTinyInPlace(c);
      const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: sr, timestamp });
      try {
        await guardStep(audioSource.add(sample), signal, STEP_TIMEOUT_MS);
      } finally {
        sample.close();
      }
    };
    // lead-in: silence, or the original from before range.start
    if (lead > 0) await addBlock(new Float32Array(tl.leadFrames * 2), tl.leadFrames, 0, 0);
    if (sound === 'original') {
      // no piano: the same 45 s pieces, holding only the original
      const chunk = 45 * sr;
      for (let f0 = 0; f0 < tl.bodyFrames; f0 += chunk) {
        if (signal?.aborted) throw abortError();
        const n = Math.min(chunk, tl.bodyFrames - f0);
        await addBlock(new Float32Array(n * 2), n, tl.leadFrames + f0, lead + f0 / sr);
        progress({ phase: 'audio', fraction: ((f0 + n) / tl.bodyFrames) * audioWeight });
      }
    } else {
      await renderOfflineChunks(
        {
          notes: arr.notes,
          pedal: arr.pedal,
          settings: job.audio,
          start: range.start,
          end: range.end,
          rate,
          sampleRate: sr,
          volume: s.volume,
          fadeIn: s.fadeIn,
          fadeOut: s.fadeOut,
          // fades follow the picture: measured from the start of the file, not of the piano (after the lead-in)
          fadeTimeline: { offset: lead, duration },
          tail,
          chunkSeconds: 45,
          signal,
          onProgress: (f) => progress({ phase: 'audio', fraction: f * audioWeight }),
        },
        async (buf, from, to, offset) => {
          const n = to - from;
          const data = new Float32Array(n * 2);
          data.set(buf.getChannelData(0).subarray(from, to), 0);
          data.set(buf.getChannelData(1).subarray(from, to), n);
          await addBlock(data, n, tl.leadFrames + Math.round(offset * sr), lead + offset);
        },
      );
    }
    audioSource.close();
    orig = null; // free the decoded recording before any frame is drawn

    // ---------- video ----------
    const songTimeAt = (o: number) => range.start + (o - lead) * rate;
    bg = await backgroundProvider(visual, function* () {
      for (let i = 0; i < totalFrames; i++) yield i / fps;
    });
    const t0 = performance.now();
    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw abortError();
      const o = i / fps;
      if (bg.kind) renderer.setBackgroundMedia(await bg.frameAt(o), bg.kind);
      renderer.render({ time: songTimeAt(o) });
      // fade the picture in/out with the audio
      const fade = fadeGain(o, duration, s.fadeIn, s.fadeOut);
      if (fade < 1) {
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = `rgba(0,0,0,${1 - fade})`;
        ctx.fillRect(0, 0, width, height);
      }
      await guardStep(videoSource.add(o, 1 / fps), signal, STEP_TIMEOUT_MS);
      if (i % 15 === 0 || i === totalFrames - 1) {
        const elapsed = (performance.now() - t0) / 1000;
        const rfps = (i + 1) / Math.max(0.001, elapsed);
        progress({
          phase: 'video',
          fraction: audioWeight + ((i + 1) / totalFrames) * (1 - audioWeight - 0.02),
          framesDone: i + 1,
          framesTotal: totalFrames,
          renderFps: rfps,
          etaSeconds: (totalFrames - i - 1) / rfps,
        });
      }
    }
    videoSource.close();
    progress({ phase: 'finalizing', fraction: 0.99 });
    await guardStep(output.finalize(), signal, finalizeTimeoutMs(duration));
    const blob = await getBlob(mime);
    progress({ phase: 'finalizing', fraction: 1 });
    return { blob, mime, extension: ext, videoCodec, audioCodec, width, height, duration, method: 'webcodecs', sound };
  } catch (err) {
    forceStopAudioEncoder(audioSource);
    await cancelOutput(output);
    await cleanup();
    throw err;
  } finally {
    orig = null;
    bg?.dispose();
    renderer.setDecalImage(null);
    decal?.close();
  }
}

/**
 * Fallback for browsers without WebCodecs: renders in real time to a canvas and records it
 * together with the live piano audio. Output is WebM and takes as long as the music.
 */
async function exportWithMediaRecorder(job: ExportJob): Promise<ExportResult> {
  if (typeof MediaRecorder === 'undefined') throw new Error('This browser supports neither WebCodecs nor MediaRecorder, so videos cannot be exported here.');
  const { song, settings: s, signal } = job;
  const { width, height } = outputSize(s);
  const range = exportRange(job);
  const rate = s.rate;
  const lead = s.leadIn;
  const tail = Math.max(1.5, s.fadeOut);
  const duration = lead + (range.end - range.start) / rate + tail;
  const canvas = document.createElement('canvas');
  const visual = exportVisual(job);
  const renderer = new PianoRollRenderer(canvas, visual);
  renderer.resize(width, height);
  const arr = song.arrangements[job.difficulty];
  renderer.setNotes(arr.notes, arr.pedal, song.tempo, song.key);
  const bg = await backgroundProvider(visual, function* () {
    for (;;) yield 0;
  });
  if (bg.kind === 'image') renderer.setBackgroundMedia(await bg.frameAt(0), 'image');
  const decal = await loadDecalBitmap(visual);
  applyDecal(renderer, decal);
  const disposeVisuals = () => {
    bg.dispose();
    renderer.setDecalImage(null);
    decal?.close();
  };

  // audio graph + capture stream: released in `finally` so a cancelled or failed export doesn't leak a running AudioContext
  let ctx: AudioContext | null = null;
  let engine: PianoEngine | null = null;
  let stream: MediaStream | null = null;
  try {
    const ac = new AudioContext({ sampleRate: 48000 });
    ctx = ac;
    const dest = ac.createMediaStreamDestination();
    const gain = ac.createGain();
    gain.gain.value = s.volume;
    gain.connect(dest);
    engine = new PianoEngine(ac, gain);
    await engine.applySettings(job.audio, undefined, true);
    stream = new MediaStream([...canvas.captureStream(s.fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrateFor(width, height, s.fps, s.quality) });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    const startCtx = ac.currentTime + 0.3;
    for (const e of buildEvents(arr.notes, arr.pedal, { L: true, R: true })) {
      if (e.t < range.start || e.t > range.end + 10) continue;
      const when = startCtx + lead + (e.t - range.start) / rate;
      if (e.kind === 'on') engine.noteOn(e.midi, e.vel, when, e.tag);
      else if (e.kind === 'off') engine.noteOff(e.midi, when, e.tag);
      else engine.setPedal(e.down, when);
    }
    rec.start(1000);
    await new Promise<void>((resolve, reject) => {
      const frame = () => {
        if (signal?.aborted) {
          rec.stop();
          reject(new DOMException('Export cancelled', 'AbortError'));
          return;
        }
        const o = ac.currentTime - startCtx;
        renderer.render({ time: range.start + (o - lead) * rate });
        job.onProgress?.({ phase: 'video', fraction: Math.max(0, Math.min(1, o / duration)) });
        if (o >= duration) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'video/webm' }));
      rec.stop();
    });
    const isMp4 = blob.type.includes('mp4');
    return {
      blob,
      mime: blob.type,
      extension: isMp4 ? 'mp4' : 'webm',
      videoCodec: mime,
      audioCodec: 'opus',
      width,
      height,
      duration,
      method: 'mediarecorder',
      sound: 'piano',
    };
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
    engine?.dispose();
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    disposeVisuals();
  }
}
