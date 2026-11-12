// Dev-only harness (source-separation research): transcribes an audio file with the REAL app
// pipeline and reports how "melody-like" the result is. Audio is passed in by the Playwright
// driver as base64 so no (copyrighted) audio ever has to live inside the repository.
import { transcribeAudio, EXTRACTION_PRESETS } from '../../src/lib/transcription/pipeline';
import type { Note } from '../../src/lib/music/types';

function b64ToBlob(b64: string, type = 'audio/wav'): Blob {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
}

/** Polyphony statistics on a 10 ms grid. */
function lineStats(notes: Note[], duration: number) {
  const n = Math.ceil(duration * 100);
  const count = new Uint8Array(n);
  for (const x of notes) for (let i = Math.floor(x.start * 100); i < Math.min(n, Math.ceil((x.start + x.dur) * 100)); i++) count[i]++;
  let active = 0, poly = 0, sum = 0;
  for (const c of count) if (c) { active++; sum += c; if (c > 1) poly++; }
  const midis = notes.map((x) => x.midi).sort((a, b) => a - b);
  return {
    notes: notes.length,
    notesPerSec: +(notes.length / duration).toFixed(2),
    activeFrac: +(active / n).toFixed(3),
    meanPolyphony: +(sum / (active || 1)).toFixed(2),
    polyFrac: +(poly / (active || 1)).toFixed(3),
    p10: midis[Math.floor(midis.length * 0.1)] ?? null,
    p90: midis[Math.floor(midis.length * 0.9)] ?? null,
  };
}

/** Simple monophonic reduction (what a "vocal melody" mode would do): at each onset keep the most
 *  confident/loudest sounding note in the vocal range, truncate overlaps, drop short leftovers. */
function monophonic(notes: Note[], lo = 48, hi = 84): Note[] {
  const cand = notes.filter((n) => n.midi >= lo && n.midi <= hi).sort((a, b) => a.start - b.start || b.vel - a.vel);
  const out: Note[] = [];
  for (const n of cand) {
    const prev = out[out.length - 1];
    if (prev && n.start < prev.start + prev.dur) {
      // overlapping: keep the louder; a much louder newcomer cuts the previous note
      if (n.vel > prev.vel * 1.15 && n.start - prev.start > 0.08) { prev.dur = n.start - prev.start; out.push({ ...n }); }
      continue;
    }
    out.push({ ...n });
  }
  return out.filter((n) => n.dur >= 0.08);
}

/** Onset F1 (pitch exact or octave-agnostic, 50 ms) between two note lists. */
function f1(ref: Note[], est: Note[], tol = 0.05, chroma = false) {
  const used = new Set<number>();
  let tp = 0;
  for (const r of ref) {
    let best = -1, bd = Infinity;
    est.forEach((e, i) => {
      if (used.has(i)) return;
      const ok = chroma ? (e.midi - r.midi) % 12 === 0 : e.midi === r.midi;
      const d = Math.abs(e.start - r.start);
      if (ok && d <= tol && d < bd) { best = i; bd = d; }
    });
    if (best >= 0) { used.add(best); tp++; }
  }
  const p = est.length ? tp / est.length : 0, rc = ref.length ? tp / ref.length : 0;
  return { p: +p.toFixed(3), r: +rc.toFixed(3), f1: +(p + rc ? (2 * p * rc) / (p + rc) : 0).toFixed(3) };
}

async function transcribeB64(b64: string, preset: keyof typeof EXTRACTION_PRESETS = 'mix') {
  const t0 = performance.now();
  const res = await transcribeAudio(b64ToBlob(b64), EXTRACTION_PRESETS[preset], () => {});
  const mono = monophonic(res.notes);
  return {
    ms: Math.round(performance.now() - t0),
    backend: res.info.backend,
    raw: lineStats(res.notes, res.duration),
    mono: lineStats(mono, res.duration),
    notes: res.notes.map((n) => [n.midi, +n.start.toFixed(3), +n.dur.toFixed(3), +n.vel.toFixed(2), n.hand]),
    monoNotes: mono.map((n) => [n.midi, +n.start.toFixed(3), +n.dur.toFixed(3)]),
  };
}

const toNotes = (a: (number | string)[][]): Note[] => a.map(([midi, start, dur], i) => ({ id: i, midi: +midi, start: +start, dur: +dur, vel: 0.5, hand: 'R' }) as Note);
function compare(refArr: (number | string)[][], estArr: (number | string)[][]) {
  const ref = toNotes(refArr), est = toNotes(estArr);
  return { exact: f1(ref, est), octaveAgnostic: f1(ref, est, 0.05, true), loose100ms: f1(ref, est, 0.1) };
}

Object.assign(window, { transcribeB64, compare });
document.getElementById('log')!.textContent = 'ready';
