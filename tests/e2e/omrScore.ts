/**
 * Note-level scoring of sheet-music reading (src/lib/omr) against a known piece, the same metrics as
 * the research prototype's scorer:
 *  - notesF1 ("pitch F1"): chords in order are aligned (Needleman–Wunsch); a note counts when the same
 *    MIDI pitch is in the aligned chord. Tolerant of rhythm mistakes: which notes, in which order.
 *  - rhythmF1 ("timed F1"): notesF1 matches whose chord keeps the same time offset as the previous
 *    matched chord (the local rhythm is right; one wrong duration costs only locally).
 *  - strictF1: same pitch at the same time (quarter notes from the first note).
 */
export interface ScoreNote {
  midi: number;
  /** quarter notes */
  onset: number;
}

export interface OmrScore {
  notesF1: number;
  rhythmF1: number;
  strictF1: number;
  precision: number;
  recall: number;
  nTruth: number;
  nRead: number;
}

function normalize(notes: ScoreNote[]): [number, number][] {
  if (!notes.length) return [];
  const t0 = Math.min(...notes.map((n) => n.onset));
  const seen = new Map<string, [number, number]>();
  for (const n of notes) {
    const o = Math.round((n.onset - t0) * 1e4) / 1e4;
    seen.set(`${n.midi}@${o}`, [n.midi, o]);
  }
  return [...seen.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function groups(notes: [number, number][]): [number, Set<number>][] {
  const g = new Map<number, Set<number>>();
  for (const [m, o] of notes) {
    if (!g.has(o)) g.set(o, new Set());
    g.get(o)!.add(m);
  }
  return [...g.entries()].sort((a, b) => a[0] - b[0]);
}

function inter(a: Set<number>, b: Set<number>): number {
  let c = 0;
  for (const x of a) if (b.has(x)) c++;
  return c;
}

function align(G: [number, Set<number>][], P: [number, Set<number>][]): [number, number][] {
  const n = G.length;
  const m = P.length;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) (D[i][0] = D[i - 1][0] + G[i - 1][1].size), (B[i][0] = 1);
  for (let j = 1; j <= m; j++) (D[0][j] = D[0][j - 1] + P[j - 1][1].size), (B[0][j] = 2);
  for (let i = 1; i <= n; i++) {
    const gi = G[i - 1][1];
    for (let j = 1; j <= m; j++) {
      const pj = P[j - 1][1];
      const sub = D[i - 1][j - 1] + gi.size + pj.size - 2 * inter(gi, pj);
      const del = D[i - 1][j] + gi.size;
      const ins = D[i][j - 1] + pj.size;
      const best = Math.min(sub, del, ins);
      D[i][j] = best;
      B[i][j] = best === sub ? 0 : best === del ? 1 : 2;
    }
  }
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const b = B[i][j];
    if (i > 0 && j > 0 && b === 0) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (i > 0 && (j === 0 || b === 1)) i--;
    else j--;
  }
  return pairs.reverse();
}

const f1 = (tp: number, ng: number, np: number) => {
  const p = np ? tp / np : 0;
  const r = ng ? tp / ng : 0;
  return { f: p + r ? (2 * p * r) / (p + r) : 0, p, r };
};

export function scoreNotes(truth: ScoreNote[], read: ScoreNote[]): OmrScore {
  const gt = normalize(truth);
  const pr = normalize(read);
  const G = groups(gt);
  const P = groups(pr);
  const pairs = G.length && P.length ? align(G, P) : [];
  let tp = 0;
  let ttp = 0;
  let prevOff = 0;
  for (const [gi, pj] of pairs) {
    const k = inter(G[gi][1], P[pj][1]);
    if (!k) continue;
    const off = P[pj][0] - G[gi][0];
    tp += k;
    if (Math.abs(off - prevOff) < 1e-3) ttp += k;
    prevOff = off;
  }
  const gs = new Set(gt.map(([m, o]) => `${m}@${o}`));
  const stp = pr.filter(([m, o]) => gs.has(`${m}@${o}`)).length;
  const a = f1(tp, gt.length, pr.length);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    notesF1: r3(a.f),
    rhythmF1: r3(f1(ttp, gt.length, pr.length).f),
    strictF1: r3(f1(stp, gt.length, pr.length).f),
    precision: r3(a.p),
    recall: r3(a.r),
    nTruth: gt.length,
    nRead: pr.length,
  };
}
