/**
 * Note scores for the homr reader's browser check (tests/e2e/homr.ts), the same metrics as the OMR
 * research scorer: chords in order are aligned (Needleman–Wunsch); a note counts when the same MIDI
 * pitch is in the aligned chord (notesF1, tolerant of rhythm mistakes); rhythmF1 also needs the same
 * time offset as the previous matched chord.
 */
export interface ScoreNote {
  midi: number;
  /** quarter notes */
  onset: number;
}

type Group = [number, Set<number>];

function groups(notes: ScoreNote[]): Group[] {
  if (!notes.length) return [];
  const t0 = Math.min(...notes.map((n) => n.onset));
  const g = new Map<number, Set<number>>();
  for (const n of notes) {
    const o = Math.round((n.onset - t0) * 1e4) / 1e4;
    if (!g.has(o)) g.set(o, new Set());
    g.get(o)!.add(n.midi);
  }
  return [...g.entries()].sort((a, b) => a[0] - b[0]);
}

const inter = (a: Set<number>, b: Set<number>) => [...a].filter((x) => b.has(x)).length;

function align(G: Group[], P: Group[]): [number, number][] {
  const n = G.length;
  const m = P.length;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) (D[i][0] = D[i - 1][0] + G[i - 1][1].size), (B[i][0] = 1);
  for (let j = 1; j <= m; j++) (D[0][j] = D[0][j - 1] + P[j - 1][1].size), (B[0][j] = 2);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = D[i - 1][j - 1] + G[i - 1][1].size + P[j - 1][1].size - 2 * inter(G[i - 1][1], P[j - 1][1]);
      const del = D[i - 1][j] + G[i - 1][1].size;
      const ins = D[i][j - 1] + P[j - 1][1].size;
      D[i][j] = Math.min(sub, del, ins);
      B[i][j] = D[i][j] === sub ? 0 : D[i][j] === del ? 1 : 2;
    }
  }
  const pairs: [number, number][] = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    if (i > 0 && j > 0 && B[i][j] === 0) pairs.push([--i, --j]);
    else if (i > 0 && (j === 0 || B[i][j] === 1)) i--;
    else j--;
  }
  return pairs.reverse();
}

const f1 = (tp: number, ng: number, np: number) => {
  const p = np ? tp / np : 0;
  const r = ng ? tp / ng : 0;
  return p + r ? (2 * p * r) / (p + r) : 0;
};

export function scoreNotes(truth: ScoreNote[], read: ScoreNote[]) {
  const G = groups(truth);
  const P = groups(read);
  const nG = G.reduce((a, g) => a + g[1].size, 0);
  const nP = P.reduce((a, g) => a + g[1].size, 0);
  let tp = 0;
  let ttp = 0;
  let prev = 0;
  for (const [gi, pj] of G.length && P.length ? align(G, P) : []) {
    const k = inter(G[gi][1], P[pj][1]);
    if (!k) continue;
    const off = P[pj][0] - G[gi][0];
    tp += k;
    if (Math.abs(off - prev) < 1e-3) ttp += k;
    prev = off;
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { notesF1: r3(f1(tp, nG, nP)), rhythmF1: r3(f1(ttp, nG, nP)), nTruth: nG, nRead: nP };
}
