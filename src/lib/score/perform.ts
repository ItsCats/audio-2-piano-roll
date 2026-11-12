/**
 * Plays a ScoreIR: follows the performance order (unroll.ts), merges tied notes, places grace
 * notes, applies dynamics / accents, builds the tempo map (tempo marks, fermatas) and the beat
 * grid, and converts everything to seconds.
 */
import { DEFAULT_QPM, DEFAULT_VEL, type IRMeasure, type IRNote, type ScoreIR } from './ir';
import { unroll, type PerformedMeasure } from './unroll';

const EPS = 1e-6;
/** A fermata holds its notes this much longer. */
export const FERMATA_STRETCH = 1.5;
/** Longest grace note (acciaccatura) in quarters, and in seconds. */
const GRACE_Q = 0.125;
const GRACE_MAX_S = 0.09;

/** A performed note, in quarter notes from the start of the performance (and in seconds). */
export interface PerformedNote {
  part: number;
  staff: number;
  voice: string;
  midi: number;
  /** quarters */
  on: number;
  off: number;
  vel: number;
  grace?: boolean;
  /** Index into the performance order of the measure the note starts in. */
  perf: number;
}

export interface TempoMap {
  /** Breakpoints in quarters, ascending, starting at 0. */
  q: number[];
  /** Seconds at each breakpoint. */
  sec: number[];
  /** Seconds per quarter from each breakpoint on. */
  spq: number[];
}

export function qToSec(map: TempoMap, q: number): number {
  let lo = 0;
  let hi = map.q.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.q[mid] <= q) lo = mid;
    else hi = mid - 1;
  }
  return map.sec[lo] + (q - map.q[lo]) * map.spq[lo];
}

export function secToQ(map: TempoMap, t: number): number {
  let lo = 0;
  let hi = map.sec.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.sec[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return map.q[lo] + (t - map.sec[lo]) / map.spq[lo];
}

export interface Performance {
  order: PerformedMeasure[];
  /** Start of each performed measure in quarters (length order.length + 1). */
  measureStart: number[];
  notes: PerformedNote[];
  /** Sustain pedal down ranges in quarters. */
  pedal: { on: number; off: number }[];
  tempo: TempoMap;
  /** Quarter-notes-per-minute marks in force, in performance order (for the first tempo). */
  firstQpm: number;
  warnings: string[];
}

export function perform(ir: ScoreIR): Performance {
  const { order, warnings } = unroll(ir.measures);
  const measureStart: number[] = [0];
  for (const pm of order) measureStart.push(measureStart[measureStart.length - 1] + ir.measures[pm.index].length);

  // ---- notes in performance order, with dynamics
  type Ev = { q: number; kind: 0 | 1; part: number; vel: number; after?: number; accent?: boolean };
  const dyn: Ev[] = [];
  let notes: (PerformedNote & { tieStart?: boolean; tieStop?: boolean; graceKind?: IRNote['grace']; graceAfter?: boolean; chord?: boolean; seq: number; accent?: number; explicitVel?: number })[] = [];
  order.forEach((pm, k) => {
    const M = ir.measures[pm.index];
    const base = measureStart[k];
    for (const d of M.dynamics) dyn.push({ q: base + d.pos, kind: 0, part: d.part, vel: d.vel, after: d.after, accent: d.kind === 'accent' });
    for (const n of M.notes) {
      if (ir.parts[n.part]?.ignored) continue;
      notes.push({
        part: n.part,
        staff: n.staff,
        voice: n.voice,
        midi: n.midi,
        on: base + n.pos,
        off: base + n.pos + n.dur,
        vel: DEFAULT_VEL,
        perf: k,
        seq: n.seq,
        tieStart: n.tieStart,
        tieStop: n.tieStop,
        graceKind: n.grace,
        graceAfter: n.graceAfter,
        chord: n.chord,
        grace: !!n.grace,
        accent: n.accent,
        explicitVel: n.vel,
      });
    }
  });
  notes.sort((a, b) => a.on - b.on || a.seq - b.seq);
  dyn.sort((a, b) => a.q - b.q);

  // dynamics: level per part in performance order; accent dynamics hit the notes struck right there
  const level = new Map<number, number>();
  let di = 0;
  const accents: Ev[] = [];
  for (const n of notes) {
    while (di < dyn.length && dyn[di].q <= n.on + EPS) {
      const d = dyn[di++];
      if (d.accent) {
        accents.push(d);
        if (d.after !== undefined) level.set(d.part, d.after);
      } else level.set(d.part, d.vel);
    }
    let v = level.get(n.part) ?? DEFAULT_VEL;
    const acc = accents.find((a) => a.part === n.part && Math.abs(a.q - n.on) < 1e-4);
    if (acc) v = acc.vel;
    if (n.explicitVel !== undefined) v = n.explicitVel;
    if (n.accent) v += n.accent;
    if (n.grace) v *= 0.85;
    n.vel = Math.max(0.05, Math.min(1, v));
  }

  // ---- tempo map: tempo marks in performance order, fermatas held longer
  const marks: { q: number; qpm: number }[] = [];
  order.forEach((pm, k) => {
    for (const t of ir.measures[pm.index].tempos) marks.push({ q: measureStart[k] + t.pos, qpm: t.qpm });
  });
  marks.sort((a, b) => a.q - b.q);
  const firstQpm = marks[0]?.qpm ?? DEFAULT_QPM;
  const ferm: [number, number][] = [];
  order.forEach((pm, k) => {
    for (const f of ir.measures[pm.index].fermatas) ferm.push([measureStart[k] + f.pos, measureStart[k] + f.pos + f.dur]);
  });
  const fermU = union(ferm);
  const cuts = new Set<number>([0]);
  for (const m of marks) cuts.add(Math.max(0, m.q));
  for (const [a, b] of fermU) {
    cuts.add(a);
    cuts.add(b);
  }
  const qs = [...cuts].sort((a, b) => a - b);
  const tempo: TempoMap = { q: [], sec: [], spq: [] };
  let mi = 0;
  let qpm = firstQpm;
  let fi = 0;
  for (let k = 0; k < qs.length; k++) {
    const q = qs[k];
    while (mi < marks.length && marks[mi].q <= q + EPS) qpm = marks[mi++].qpm;
    while (fi < fermU.length && fermU[fi][1] <= q + EPS) fi++;
    const inFerm = fi < fermU.length && fermU[fi][0] <= q + EPS;
    const spq = (60 / Math.max(10, Math.min(1000, qpm))) * (inFerm ? FERMATA_STRETCH : 1);
    const last = tempo.q.length - 1;
    if (last >= 0 && Math.abs(tempo.spq[last] - spq) < 1e-12) continue;
    const sec = last >= 0 ? tempo.sec[last] + (q - tempo.q[last]) * tempo.spq[last] : 0;
    tempo.q.push(q);
    tempo.sec.push(sec);
    tempo.spq.push(spq);
  }

  // ---- ties: a tie start continues into the next same-pitch note on the same staff that starts where it ends
  {
    const open = new Map<string, (typeof notes)[number]>();
    const keep: typeof notes = [];
    for (const n of notes) {
      if (n.grace) {
        keep.push(n);
        continue;
      }
      const key = `${n.part}|${n.staff}|${n.midi}`;
      const o = open.get(key);
      if (o && Math.abs(o.off - n.on) < 1e-4) {
        o.off = Math.max(o.off, n.off);
        if (!n.tieStart) open.delete(key);
        continue;
      }
      if (o) open.delete(key);
      if (n.tieStart) open.set(key, n);
      keep.push(n);
    }
    // a tie into the next note on the other staff (cross-staff writing)
    notes = keep;
  }

  // ---- grace notes: before the main note on its beat, taking time from it (after it: from its end)
  {
    const groups = new Map<string, typeof notes>();
    for (const n of notes) {
      if (!n.grace) continue;
      const key = `${n.part}|${n.voice}|${n.on.toFixed(5)}|${n.graceAfter ? 'a' : 'b'}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(n);
    }
    const mains = new Map<string, typeof notes>();
    for (const n of notes) {
      if (n.grace) continue;
      for (const key of [`${n.part}|${n.voice}|${n.on.toFixed(5)}`, `${n.part}|*${n.staff}|${n.on.toFixed(5)}`]) {
        let g = mains.get(key);
        if (!g) mains.set(key, (g = []));
        g.push(n);
      }
    }
    for (const [key, g] of groups) {
      g.sort((a, b) => a.seq - b.seq);
      // a grace chord shares one slot
      const slots: (typeof notes)[] = [];
      for (const n of g) {
        if (n.chord && slots.length) slots[slots.length - 1].push(n);
        else slots.push([n]);
      }
      const [part, voice, onS, kind] = key.split('|');
      const on = parseFloat(onS);
      const staff = g[0].staff;
      const main = kind === 'b' ? (mains.get(`${part}|${voice}|${onS}`) ?? mains.get(`${part}|*${staff}|${onS}`) ?? []) : [];
      const mainDur = main.length ? Math.min(...main.map((m) => m.off - m.on)) : 0.5;
      const shortQ = Math.min(GRACE_Q, GRACE_MAX_S / spqAt(tempo, on));
      // a single unslashed grace (appoggiatura) takes half of the main note; others are short
      const appo = kind === 'b' && slots.length === 1 && g.every((n) => n.graceKind === 'appoggiatura') && main.length > 0;
      const each = appo ? Math.max(shortQ, Math.min(mainDur / 2, 2)) : Math.min(shortQ, mainDur / (2 * slots.length));
      if (kind === 'a') {
        // after the main note: at the end of the notes before this point in the same voice
        const before = notes.filter((m) => !m.grace && String(m.part) === part && m.voice === voice && m.on < on - EPS && m.off >= on - EPS);
        const start = on - each * slots.length;
        for (const m of before) if (m.off > start) m.off = Math.max(m.on + (m.off - m.on) / 2, start);
        slots.forEach((sl, i) => sl.forEach((n) => ((n.on = start + i * each), (n.off = n.on + each))));
        continue;
      }
      slots.forEach((sl, i) => sl.forEach((n) => ((n.on = on + i * each), (n.off = n.on + each))));
      const shift = each * slots.length;
      for (const m of main) m.on = Math.min(m.on + shift, m.off - Math.min(shift, (m.off - m.on) / 2));
    }
  }

  // ---- pedal (quarters), in performance order
  const pedal: { on: number; off: number }[] = [];
  {
    const evs: { q: number; type: 'down' | 'up' | 'change' }[] = [];
    order.forEach((pm, k) => {
      for (const p of ir.measures[pm.index].pedal) evs.push({ q: measureStart[k] + p.pos, type: p.type });
    });
    evs.sort((a, b) => a.q - b.q);
    let down: number | null = null;
    for (const e of evs) {
      if (e.type === 'down') down ??= e.q;
      else {
        if (down !== null && e.q - down > EPS) pedal.push({ on: down, off: e.q });
        down = e.type === 'change' ? e.q : null;
      }
    }
    const end = measureStart[measureStart.length - 1];
    if (down !== null && end - down > EPS) pedal.push({ on: down, off: end });
  }

  const out: PerformedNote[] = notes.map((n) => ({
    part: n.part,
    staff: n.staff,
    voice: n.voice,
    midi: n.midi,
    on: n.on,
    off: n.off,
    vel: n.vel,
    perf: n.perf,
    ...(n.grace ? { grace: true } : {}),
  }));
  out.sort((a, b) => a.on - b.on || a.midi - b.midi);
  return { order, measureStart, notes: out, pedal, tempo, firstQpm, warnings };
}

function spqAt(map: TempoMap, q: number): number {
  let k = 0;
  while (k + 1 < map.q.length && map.q[k + 1] <= q) k++;
  return map.spq[k];
}

function union(iv: [number, number][]): [number, number][] {
  const s = iv.filter(([a, b]) => b > a + EPS).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + EPS) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Measures of a performance as indices into the written measures (for messages and tests). */
export const performedLabels = (ir: ScoreIR, p: Performance): string[] => p.order.map((pm) => ir.measures[pm.index].label);

export type { IRMeasure };
