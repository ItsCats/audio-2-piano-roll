/**
 * Audio decoding. Uses the browser's native decoder (MP3, WAV, AAC/M4A, MP4 audio, OGG,
 * FLAC, Opus/WebM where supported) and falls back to mediabunny (WebCodecs) for containers
 * the native decoder rejects (e.g. MKV, MOV, some MP4 variants).
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';

export const MAX_FILE_BYTES = 300 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 20 * 60;
/**
 * Videos (a phone video of someone playing) may be much larger: above this size their sound is read
 * straight from the file (mediabunny, streamed), without loading the whole file into memory.
 */
export const STREAM_DECODE_BYTES = 200 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'];
/** A video container (by type or extension). */
export function isVideoFile(f: { name?: string; type: string }): boolean {
  return f.type.startsWith('video/') || VIDEO_EXTENSIONS.includes(fileExtension(f.name ?? ''));
}

export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm', 'mov', 'mkv', 'aif', 'aiff', 'wma'];
export const MIDI_EXTENSIONS = ['mid', 'midi', 'kar'];
/** Sheet-music files (lib/score): MusicXML, compressed MusicXML, MuseScore. */
export const SCORE_EXTENSIONS = ['musicxml', 'xml', 'mxl', 'mscz', 'mscx'];

export function fileExtension(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function classifyFile(file: File): 'audio' | 'midi' | 'score' | 'unsupported' {
  const ext = fileExtension(file.name);
  if (MIDI_EXTENSIONS.includes(ext) || file.type === 'audio/midi' || file.type === 'audio/x-midi') return 'midi';
  if (SCORE_EXTENSIONS.includes(ext) || /musicxml/.test(file.type)) return 'score';
  if (AUDIO_EXTENSIONS.includes(ext) || file.type.startsWith('audio/') || file.type.startsWith('video/')) return 'audio';
  return 'unsupported';
}

async function decodeNative(data: ArrayBuffer, sampleRate: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  return await ctx.decodeAudioData(data);
}

async function decodeWithMediabunny(blob: Blob, sampleRate: number): Promise<AudioBuffer> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('No audio track found in this file.');
  if (!(await track.canDecode())) throw new Error(`This browser cannot decode the file's audio codec (${track.codec ?? 'unknown'}).`);
  const duration = await track.computeDuration();
  if (duration > MAX_DURATION_SECONDS) throw new Error(tooLong(duration));
  const sink = new AudioBufferSink(track);
  const chunks: { buffer: AudioBuffer; timestamp: number }[] = [];
  for await (const { buffer, timestamp } of sink.buffers()) chunks.push({ buffer, timestamp });
  if (!chunks.length) throw new Error('The audio track is empty.');
  const srcRate = chunks[0].buffer.sampleRate;
  // each block where its timestamp puts it: a gap in the file (an interrupted recording, an edited
  // file) stays a silent gap, so everything after it keeps its place on the file's timeline
  const at = placeByTimestamp(
    chunks.map((c) => c.timestamp),
    chunks.map((c) => c.buffer.length),
    srcRate,
  );
  const total = chunks.reduce((m, c, i) => Math.max(m, at[i] + c.buffer.length), 0);
  const mono = new Float32Array(total);
  chunks.forEach(({ buffer: b }, k) => {
    const piece = new Float32Array(b.length);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) piece[i] += d[i] / b.numberOfChannels;
    }
    mono.set(piece, at[k]);
  });
  // resample with the browser's high-quality resampler
  const outLen = Math.ceil((total * sampleRate) / srcRate);
  const ctx = new OfflineAudioContext(1, outLen, sampleRate);
  const src = ctx.createBuffer(1, total, srcRate);
  src.copyToChannel(mono, 0);
  const node = ctx.createBufferSource();
  node.buffer = src;
  node.connect(ctx.destination);
  node.start();
  return await ctx.startRendering();
}

/**
 * Where each decoded block goes (frames from the first block's start), from its timestamp. Blocks that
 * follow on within a couple of frames are joined end to end (timestamps are rounded in the file), so
 * only a real gap or overlap moves a block.
 */
export function placeByTimestamp(timestamps: number[], lengths: number[], rate: number): number[] {
  const out: number[] = [];
  if (!timestamps.length) return out;
  const t0 = timestamps[0];
  let next = 0;
  for (let i = 0; i < timestamps.length; i++) {
    const want = Math.round((timestamps[i] - t0) * rate);
    const at = Math.abs(want - next) <= 2 ? next : Math.max(0, want);
    out.push(at);
    next = at + lengths[i];
  }
  return out;
}

const tooLong = (d: number) =>
  `This recording is ${Math.round(d / 60)} minutes long. The limit is ${MAX_DURATION_SECONDS / 60} minutes — trim it first.`;

/** Decode to an AudioBuffer at `sampleRate` (the browser resamples during decoding). */
export async function decodeToRate(blob: Blob, sampleRate: number): Promise<AudioBuffer> {
  if (blob.size === 0) throw new Error('File is empty.');
  if (decodeRoute(blob) === 'stream') {
    try {
      return checkDecoded(await decodeWithMediabunny(blob, sampleRate));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not decode this file. ${msg}`, { cause: err });
    }
  }
  if (blob.size > MAX_FILE_BYTES) throw new Error(`File is too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
  let buffer: AudioBuffer;
  try {
    buffer = await decodeNative(await blob.arrayBuffer(), sampleRate);
  } catch (nativeErr) {
    try {
      buffer = await decodeWithMediabunny(blob, sampleRate);
    } catch (fallbackErr) {
      const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(`Could not decode this file. ${msg}`, { cause: nativeErr });
    }
  }
  return checkDecoded(buffer);
}

function checkDecoded(buffer: AudioBuffer): AudioBuffer {
  if (buffer.duration > MAX_DURATION_SECONDS) throw new Error(tooLong(buffer.duration));
  if (buffer.duration < 0.5) throw new Error('The audio is shorter than half a second.');
  return buffer;
}

/**
 * How decodeToRate reads a file: 'stream' (mediabunny, straight from the file: large videos) or
 * 'native' (the browser's decoder on the whole file, mediabunny if that fails). Sample 0 of a streamed
 * decode is the first audio sample in the file (its timestamp is the audio track's first timestamp).
 */
export function decodeRoute(blob: Blob): 'stream' | 'native' {
  const file = blob as Blob & { name?: string };
  return blob.size > STREAM_DECODE_BYTES && blob.size <= MAX_VIDEO_BYTES && isVideoFile({ name: file.name, type: blob.type }) ? 'stream' : 'native';
}

export function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i];
  }
  const k = 1 / buffer.numberOfChannels;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

/** Peak level and silence check, so we can warn about near-silent inputs. */
export function analyzeLevel(mono: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < mono.length; i += 4) {
    const v = Math.abs(mono[i]);
    if (v > peak) peak = v;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / Math.ceil(mono.length / 4)) };
}

/**
 * Resample mono audio from `from` Hz to `to` Hz with a Kaiser-windowed sinc (band-limited to 0.95 ×
 * the lower Nyquist, ±`taps` input samples at the lower rate's scale). For buffers that are already
 * decoded (the separated "other" stem at 22.05 kHz → the piano model's 16 kHz): decoding again would
 * hold a second copy of the whole song while separation's memory is still being freed.
 */
export function resampleTo(x: Float32Array, from: number, to: number, taps = 16): Float32Array {
  if (from === to) return x.slice();
  const ratio = to / from;
  const n = Math.max(0, Math.floor(x.length * ratio));
  const out = new Float32Array(n);
  // cutoff as a fraction of the input rate
  const fc = 0.5 * Math.min(1, ratio) * 0.95;
  const half = Math.ceil(taps / Math.min(1, ratio));
  const beta = 8;
  const i0 = (v: number) => {
    let s = 1;
    let t = 1;
    for (let k = 1; k < 30; k++) {
      t *= (v / (2 * k)) * (v / (2 * k));
      s += t;
      if (t < 1e-12 * s) break;
    }
    return s;
  };
  const i0b = i0(beta);
  // the kernel is evaluated at fractional offsets: tabulate it finely and interpolate
  const RES = 512;
  const table = new Float32Array(half * RES + 2);
  for (let k = 0; k < table.length; k++) {
    const d = k / RES;
    const w = d >= half ? 0 : i0(beta * Math.sqrt(1 - (d / half) * (d / half))) / i0b;
    const s = d === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * d) / (Math.PI * d);
    table[k] = s * w;
  }
  const kernel = (d: number) => {
    const a = Math.abs(d) * RES;
    const k = Math.floor(a);
    if (k >= table.length - 1) return 0;
    const f = a - k;
    return table[k] + (table[k + 1] - table[k]) * f;
  };
  const len = x.length;
  for (let j = 0; j < n; j++) {
    const c = j / ratio;
    const a = Math.max(0, Math.ceil(c - half));
    const b = Math.min(len - 1, Math.floor(c + half));
    let s = 0;
    for (let i = a; i <= b; i++) s += x[i] * kernel(i - c);
    out[j] = s;
  }
  return out;
}
