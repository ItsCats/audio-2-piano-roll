/**
 * Offline (faster-than-real-time, deterministic) rendering of an arrangement with the same
 * PianoEngine used for live playback. Long songs are rendered in chunks with a pre-roll so
 * memory stays bounded: each chunk replays everything that could still be ringing (samples
 * are at most ~14 s long, plus reverb tail), then only the chunk's own span is kept.
 */
import type { Hand, Note, PedalRange } from '../music/types';
import { PianoEngine } from './pianoEngine';
import { buildEvents } from './events';
import type { AudioSettings } from './types';

export interface OfflineRenderOptions {
  notes: Note[];
  pedal: PedalRange[];
  settings: AudioSettings;
  hands?: Record<Hand, boolean>;
  /** song-time range to render */
  start: number;
  end: number;
  /** playback speed (0.25..2) */
  rate: number;
  sampleRate?: number;
  volume?: number; // extra export gain 0..1.5
  fadeIn?: number; // seconds (output time)
  fadeOut?: number;
  /** extra seconds after `end` for ringing notes / reverb */
  tail?: number;
  chunkSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

const PREROLL = 18;

/**
 * Renders and calls `onChunk` with consecutive pieces of output audio (output timeline,
 * starting at 0). Returns the total output duration in seconds.
 */
export async function renderOfflineChunks(
  opts: OfflineRenderOptions,
  onChunk: (buffer: AudioBuffer, frameFrom: number, frameTo: number, outputOffset: number) => Promise<void> | void,
): Promise<number> {
  const sr = opts.sampleRate ?? 48000;
  const rate = opts.rate;
  const tail = opts.tail ?? 2.5;
  const outDuration = (opts.end - opts.start) / rate + tail;
  const chunk = opts.chunkSeconds ?? 60;
  const events = buildEvents(opts.notes, opts.pedal, opts.hands ?? { L: true, R: true });
  const total = Math.ceil(outDuration * sr);
  const fadeIn = Math.min(opts.fadeIn ?? 0, outDuration / 2);
  const fadeOut = Math.min(opts.fadeOut ?? 0, outDuration / 2);
  const vol = opts.volume ?? 1;

  for (let c0 = 0; c0 < outDuration; c0 += chunk) {
    if (opts.signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
    const c1 = Math.min(outDuration, c0 + chunk);
    const pre = c0 === 0 ? 0 : PREROLL;
    // render the engine's processing latency extra and drop it, so output is sample-aligned
    const lat = PianoEngine.LATENCY;
    const len = Math.ceil((c1 - c0 + pre + lat) * sr);
    const ctx = new OfflineAudioContext(2, len, sr);
    const engine = new PianoEngine(ctx, ctx.destination);
    await engine.applySettings({ ...opts.settings, volume: opts.settings.volume * vol });
    // output time o (seconds) <-> context time (o - c0 + pre)
    const toCtx = (songT: number) => (songT - opts.start) / rate - c0 + pre;
    for (const e of events) {
      const ct = toCtx(e.t);
      if (ct < 0 && e.kind === 'on') continue; // starts before the pre-roll window
      if (ct >= c1 - c0 + pre) break;
      const t = Math.max(0, ct);
      if (e.kind === 'on') {
        if (e.t < opts.start - 0.001 || e.t > opts.end) continue;
        engine.noteOn(e.midi, e.vel, t, e.tag);
      } else if (e.kind === 'off') engine.noteOff(e.midi, t, e.tag);
      else if (e.t <= opts.end) engine.setPedal(e.down, t);
    }
    // release the pedal at the end of the range so the tail decays naturally
    const endCtx = toCtx(opts.end);
    if (endCtx > 0 && endCtx < len / sr) engine.setPedal(false, endCtx);
    const rendered = await ctx.startRendering();
    // fades (output timeline)
    const preFrames = Math.round((pre + lat) * sr);
    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
      const d = rendered.getChannelData(ch);
      for (let i = preFrames; i < d.length; i++) {
        const o = c0 + (i - preFrames) / sr;
        let g = 1;
        if (fadeIn > 0 && o < fadeIn) g *= o / fadeIn;
        if (fadeOut > 0 && o > outDuration - fadeOut) g *= Math.max(0, (outDuration - o) / fadeOut);
        if (g !== 1) d[i] *= g;
      }
    }
    const frameTo = Math.min(rendered.length, preFrames + Math.round((c1 - c0) * sr));
    await onChunk(rendered, preFrames, frameTo, c0);
    opts.onProgress?.(Math.min(1, (c0 + (c1 - c0)) / outDuration));
    if (Math.round(c1 * sr) >= total) break;
  }
  return outDuration;
}

/** Render to a single AudioBuffer (for short material / previews). */
export async function renderOffline(opts: OfflineRenderOptions): Promise<AudioBuffer> {
  const sr = opts.sampleRate ?? 48000;
  const parts: { buf: AudioBuffer; from: number; to: number }[] = [];
  const dur = await renderOfflineChunks({ ...opts, chunkSeconds: 1e9 }, (buf, from, to) => {
    parts.push({ buf, from, to });
  });
  const out = new AudioBuffer({ numberOfChannels: 2, length: Math.ceil(dur * sr), sampleRate: sr });
  let off = 0;
  for (const p of parts) {
    for (let c = 0; c < 2; c++) out.getChannelData(c).set(p.buf.getChannelData(c).subarray(p.from, p.to), off);
    off += p.to - p.from;
  }
  return out;
}
