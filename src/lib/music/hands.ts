/**
 * Left/right hand assignment.
 *
 * A time-varying split point is estimated per window as the widest pitch gap between
 * the notes sounding in that window (biased toward middle C and toward the previous
 * split for stability), median-smoothed, and then each onset cluster is checked so that
 * neither hand has to stretch more than a ninth in a chord.
 *
 * That check only sees the notes struck together. Notes still HELD from earlier onsets (most of
 * the 29–40-semitone stretches measured in one hand: a held bass under a new chord an octave and
 * more above it, a long chord note under a new tune note) are handled per arrangement level by
 * music/playability.ts enforcePlayability, which looks at everything sounding at each onset.
 * Running that reassign-only pass here as well (on the base transcription) was measured and not
 * kept: it moved the inputs of Easy / Medium (tune candidates, left-hand bass) and gave mixed
 * results (MAESTRO Easy RH +0.009 chroma, but Easy LH vs the bass reference −0.010 on a vocal
 * song, band-instrumental-1 confident-frame Easy RH −0.015), while Hard and Medium get the same
 * reach either way.
 */
import type { Note } from './types';
import { MAX_SPAN as LEVEL_SPAN } from './playability';

const WINDOW = 1.5; // seconds
const MAX_SPAN = LEVEL_SPAN.hard; // semitones a hand can comfortably reach within a chord (a ninth)

export function clusterOnsets<T extends { start: number }>(notes: T[], tolerance = 0.035): T[][] {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const clusters: T[][] = [];
  let cur: T[] = [];
  let anchor = -Infinity;
  for (const n of sorted) {
    if (n.start - anchor > tolerance) {
      if (cur.length) clusters.push(cur);
      cur = [n];
      anchor = n.start;
    } else {
      cur.push(n);
    }
  }
  if (cur.length) clusters.push(cur);
  return clusters;
}

function medianSmooth(values: number[], radius: number): number[] {
  return values.map((_, i) => {
    const w = values.slice(Math.max(0, i - radius), i + radius + 1).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
}

export function splitPoints(notes: Note[], duration: number): { times: number[]; splits: number[] } {
  const nWin = Math.max(1, Math.ceil(duration / WINDOW));
  const raw: number[] = [];
  let prev = 60;
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  let j = 0;
  for (let w = 0; w < nWin; w++) {
    const t0 = w * WINDOW - 0.5;
    const t1 = (w + 1) * WINDOW + 0.5;
    while (j < sorted.length && sorted[j].start + sorted[j].dur < t0 - 5) j++;
    const pitches = new Set<number>();
    for (let k = j; k < sorted.length && sorted[k].start < t1; k++) {
      const n = sorted[k];
      if (n.start + n.dur > t0) pitches.add(n.midi);
    }
    const ps = [...pitches].sort((a, b) => a - b);
    let split = prev;
    if (ps.length >= 2) {
      let bestScore = -Infinity;
      for (let i = 0; i < ps.length - 1; i++) {
        const mid = (ps[i] + ps[i + 1]) / 2;
        if (mid < 43 || mid > 77) continue;
        const gap = ps[i + 1] - ps[i];
        const score = gap - 0.18 * Math.abs(mid - 60) - 0.12 * Math.abs(mid - prev);
        if (score > bestScore) {
          bestScore = score;
          split = mid;
        }
      }
      // all notes far on one side: keep the split away from them
      if (ps[0] > 62) split = Math.min(prev, ps[0] - 0.5, 60);
      if (ps[ps.length - 1] < 58) split = Math.max(prev, ps[ps.length - 1] + 0.5, 60);
    }
    raw.push(split);
    prev = split;
  }
  const splits = medianSmooth(raw, 1);
  return { times: splits.map((_, i) => (i + 0.5) * WINDOW), splits };
}

export function assignHands(notes: Note[], duration: number): Note[] {
  if (!notes.length) return notes;
  const { splits } = splitPoints(notes, duration);
  const splitAt = (t: number) => splits[Math.min(splits.length - 1, Math.max(0, Math.floor(t / WINDOW)))];
  const out = notes.map((n) => ({ ...n, hand: (n.midi < splitAt(n.start) ? 'L' : 'R') as Note['hand'] }));

  // enforce reachable spans per onset cluster
  for (const cluster of clusterOnsets(out)) {
    const left = cluster.filter((n) => n.hand === 'L').sort((a, b) => a.midi - b.midi);
    const right = cluster.filter((n) => n.hand === 'R').sort((a, b) => a.midi - b.midi);
    // move top notes of an over-stretched left hand to the right hand
    while (left.length > 1 && left[left.length - 1].midi - left[0].midi > MAX_SPAN) {
      const top = left[left.length - 1];
      const rightTop = right.length ? right[right.length - 1].midi : top.midi;
      if (rightTop - top.midi > MAX_SPAN) break;
      top.hand = 'R';
      right.unshift(left.pop()!);
    }
    while (right.length > 1 && right[right.length - 1].midi - right[0].midi > MAX_SPAN) {
      const bottom = right[0];
      const leftBottom = left.length ? left[0].midi : bottom.midi;
      if (bottom.midi - leftBottom > MAX_SPAN) break;
      bottom.hand = 'L';
      left.push(right.shift()!);
    }
    // at most 5 fingers per hand: overflow goes to the other hand when it has room
    while (left.length > 5 && right.length < 5) {
      const top = left.pop()!;
      top.hand = 'R';
      right.unshift(top);
    }
    while (right.length > 5 && left.length < 5) {
      const bottom = right.shift()!;
      bottom.hand = 'L';
      left.push(bottom);
    }
  }
  return out;
}
