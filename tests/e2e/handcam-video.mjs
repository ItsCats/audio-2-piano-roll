/**
 * Synthetic "hands video" for the hands video tests (tests/e2e/handcam.mjs): a top-down camera view of an
 * 88-key keyboard in mild perspective with two "hands" moving below it; a key turns green while its note
 * plays, and the sound track has a piano-like tone at every note start. Made in Node and encoded with
 * ffmpeg like a phone video: H.264 + AAC in MP4, variable frame rate (timestamp jitter and a dropped
 * frame) and rotation metadata (coded portrait, shown landscape).
 *
 *   import { makeHandsVideo, NOTES } from './handcam-video.mjs'
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';

const isBlack = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
const BLACK_OFFSET = { 1: -0.12, 3: 0.12, 6: -0.15, 8: 0, 10: 0.15 };

/** an irregular melody between C3 and C6, mostly one note at a time (start, dur, midi, vel) */
export function makeNotes(seconds, seed = 3) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let t = 1.0; t < seconds - 1.5; t += 0.32 + rnd() * 0.42) {
    out.push({ start: +t.toFixed(4), dur: 0.3, midi: 48 + Math.floor(rnd() * 37), vel: 0.6 + rnd() * 0.3 });
  }
  return out;
}

/** keyboard corners in the display frame (fractions): back-left, back-right, front-right, front-left */
export const QUAD = [
  [0.1, 0.4],
  [0.92, 0.37],
  [0.97, 0.63],
  [0.05, 0.66],
];

function homography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [X, Y] = to[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++)
      if (r !== c) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}
const apply = (m, x, y) => {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
};

/** key (midi) under u ∈ [0,1) along an 88-key keyboard, and whether v is in the black-key zone */
function keyAt(u, v) {
  const ww = 1 / 52;
  const bw = ww * 0.6;
  if (v < 0.63) {
    // black keys: check the two neighbors' boundaries
    let wi = 0;
    for (let m = 21; m <= 108; m++) {
      if (!isBlack(m)) {
        wi++;
        continue;
      }
      const x = wi * ww - bw / 2 + BLACK_OFFSET[m % 12] * bw;
      if (u >= x && u < x + bw) return m;
    }
  }
  const i = Math.min(51, Math.floor(u * 52));
  let wi = -1;
  for (let m = 21; m <= 108; m++) if (!isBlack(m) && ++wi === i) return m;
  return 108;
}

const DROP = 100;
/**
 * The source video's frame times (s): ±3.5 ms jitter and one dropped frame (VFR, like a phone); frame N
 * is shown at frameTime(N), the same formula ffmpeg's setpts gets in makeHandsVideo.
 */
export function sourceFrameTimes({ seconds, fps = 30, vfr = true }) {
  const frameTime = (N) => (N + (vfr && N >= DROP ? 1 : 0)) / fps + (vfr && N > 0 ? 0.0035 * Math.sin(N * 1.7) : 0);
  const times = [];
  for (let N = 0; frameTime(N) < seconds; N++) times.push(frameTime(N));
  return times;
}

/** the center u of a key (for the tests) */
export function keyCenterU(midi) {
  const ww = 1 / 52;
  let wi = 0;
  for (let m = 21; m < midi; m++) if (!isBlack(m)) wi++;
  if (!isBlack(midi)) return (wi + 0.5) * ww;
  const bw = ww * 0.6;
  return wi * ww - bw / 2 + BLACK_OFFSET[midi % 12] * bw + bw / 2;
}

/**
 * Writes the video. `shift`: the video's content starts this much later than the song (video time =
 * song time + shift). Returns { file, frames, display }.
 */
export async function makeHandsVideo({ out, notes, seconds, shift = 0, width = 640, height = 360, fps = 30, rotation = 90, vfr = true, sampleRate = 48000 }) {
  const W = width;
  const H = height;
  const Hm = homography(
    QUAD.map(([x, y]) => [x * W, y * H]),
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  );
  // static map: per pixel the key (or -1 floor, -2 fallboard, -3 gap line) and (u, v)
  const key = new Int16Array(W * H);
  const uu = new Float32Array(W * H);
  const vv = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [u, v] = apply(Hm, x + 0.5, y + 0.5);
      const i = y * W + x;
      uu[i] = u;
      vv[i] = v;
      if (u >= 0 && u < 1 && v >= 0 && v < 1) {
        const m = keyAt(u, v);
        const gap = !isBlack(m) && ((u * 52) % 1 < 0.06 || (u * 52) % 1 > 0.97);
        key[i] = gap ? -3 : m;
      } else if (u >= -0.01 && u < 1.01 && v >= -0.18 && v < 0) key[i] = -2;
      else key[i] = -1;
    }
  const frame = Buffer.alloc(W * H * 3);
  const paint = (t) => {
    const lit = new Set(notes.filter((n) => t >= n.start + shift && t < n.start + shift + n.dur).map((n) => n.midi));
    const hands = [
      [0.35 + 0.05 * Math.sin(t * 0.9), 1.35],
      [0.62 + 0.05 * Math.sin(t * 0.7 + 1), 1.4],
    ];
    for (let i = 0; i < W * H; i++) {
      const k = key[i];
      let r, g, b;
      if (k >= 0) {
        const black = isBlack(k);
        if (lit.has(k)) [r, g, b] = black ? [16, 192, 48] : [32, 255, 64];
        else [r, g, b] = black ? [21, 21, 21] : [244, 244, 240];
      } else if (k === -3) [r, g, b] = [120, 120, 118];
      else if (k === -2) [r, g, b] = [17, 17, 17];
      else [r, g, b] = [42, 38, 34];
      // hands: skin ellipses over the front of the keys
      const u = uu[i];
      const v = vv[i];
      for (const [hu, hv] of hands) {
        const du = (u - hu) / 0.05;
        const dv = (v - hv) / 0.45;
        if (du * du + dv * dv < 1) [r, g, b] = [201, 154, 122];
      }
      frame[i * 3] = r;
      frame[i * 3 + 1] = g;
      frame[i * 3 + 2] = b;
    }
    return frame;
  };
  // sound: piano-like tones at the note starts (+ shift)
  const n = Math.round(seconds * sampleRate);
  const pcm = new Float32Array(n);
  for (const note of notes) {
    const f = 440 * 2 ** ((note.midi - 69) / 12);
    const s0 = Math.round((note.start + shift) * sampleRate);
    for (let i = 0; i < 0.8 * sampleRate; i++) {
      const k = s0 + i;
      if (k < 0 || k >= n) continue;
      const tt = i / sampleRate;
      const a = 0.3 * note.vel * Math.exp(-tt / 0.35) * Math.min(1, tt / 0.003);
      pcm[k] += a * (Math.sin(2 * Math.PI * f * tt) + 0.4 * Math.sin(4 * Math.PI * f * tt) + 0.15 * Math.sin(6 * Math.PI * f * tt));
    }
  }
  const wav = out + '.wav';
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + n * 4, 4);
  hdr.write('WAVEfmt ', 8);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(3, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(sampleRate * 4, 28);
  hdr.writeUInt16LE(4, 32);
  hdr.writeUInt16LE(32, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(n * 4, 40);
  writeFileSync(wav, Buffer.concat([hdr, Buffer.from(pcm.buffer)]));
  // frame times: jitter (±3.5 ms) and one dropped frame (VFR, like a phone); frame N is shown at
  // frameTime(N), the same formula ffmpeg's setpts gets below
  const times = sourceFrameTimes({ seconds, fps, vfr });
  const rawMkv = out + '.raw.mkv';
  // 1) frames → lossless intermediate
  await run(['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(fps), '-i', 'pipe:0', '-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast', rawMkv], async (stdin) => {
    for (const t of times) {
      const ok = stdin.write(paint(t));
      if (!ok) await new Promise((r) => stdin.once('drain', r));
    }
    stdin.end();
  });
  // 2) final: VFR timestamps, coded portrait + rotation metadata (shown landscape), AAC
  const pts = vfr ? `'(N+gte(N\\,${DROP}))/${fps}/TB+if(gt(N\\,0)\\,0.0035*sin(N*1.7)/TB\\,0)'` : 'N/FRAME_RATE/TB';
  const transpose = rotation === 90 ? 'transpose=2,' : rotation === 270 ? 'transpose=1,' : rotation === 180 ? 'transpose=2,transpose=2,' : '';
  const args = ['-y', '-v', 'error'];
  if (rotation) args.push('-display_rotation', String((360 - rotation) % 360), '-noautorotate');
  args.push('-i', rawMkv, '-i', wav, '-map', '0:v', '-map', '1:a', '-vf', `${transpose}setpts=${pts}`, '-fps_mode', 'vfr', '-enc_time_base:v', '1/90000', '-video_track_timescale', '90000', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out);
  await run(args);
  rmSync(wav, { force: true });
  rmSync(rawMkv, { force: true });
  return { file: out, frames: times, display: { w: W, h: H } };
}

function run(args, feed) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: [feed ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err}`))));
    if (feed) feed(p.stdin).catch(reject);
  });
}

/**
 * Where a tone starts near time t (s) in mono samples `x`: the first point where the peak level of the
 * next 4 ms clearly jumps over the peak level of the 20 ms before it (windows longer than a low note's
 * period, so a zero crossing never looks like silence), refined to the first sample over 15 % of the
 * jump. null when nothing starts within ±0.1 s.
 */
export function toneOnset(x, sr, t) {
  const peak = (a, b) => {
    let m = 0;
    for (let i = Math.max(0, Math.round(a)); i < Math.min(x.length, Math.round(b)); i++) m = Math.max(m, Math.abs(x[i]));
    return m;
  };
  const step = sr / 2000;
  for (let i = Math.round((t - 0.1) * sr); i < (t + 0.1) * sr; i += step) {
    const before = peak(i - 0.02 * sr, i - 0.001 * sr);
    const now = peak(i, i + 0.004 * sr);
    if (now > 0.03 && now > 1.6 * before + 0.02) {
      for (let k = Math.round(i - step); k < i + 0.004 * sr; k++) if (Math.abs(x[k]) > before + 0.15 * (now - before)) return k / sr;
      return i / sr;
    }
  }
  return null;
}
