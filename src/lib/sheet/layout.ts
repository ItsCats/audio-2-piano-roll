/** Line breaks: measures are packed greedily into lines by an estimate of their width. */
import type { Score } from './types';

/** Distinct onsets per measure (both staves). */
export function onsetsPerMeasure(score: Score): number[] {
  const out = new Array(score.measureCount).fill(0);
  const seen = new Set<number>();
  for (const n of score.notes) {
    if (seen.has(n.on)) continue;
    seen.add(n.on);
    const m = score.time.measureOf(n.on);
    if (m < out.length) out[m]++;
  }
  return out;
}

/** Width units the measures of a line may use for a container width (px) at a zoom. */
export function lineBudget(widthPx: number, zoom: number): number {
  return Math.max(2, widthPx / (zoom * 70));
}

/**
 * First measure of every line (always starts with 0). A measure is about 1 + 0.3 × its distinct
 * onsets wide; a line holds at most `budget` units and 1–6 measures.
 */
export function systemBreaks(score: Score, budget: number, prevBreaks?: number[]): number[] {
  const ons = onsetsPerMeasure(score);
  const width = (m: number) => 1 + 0.3 * ons[m] + (m === 0 ? 1 : 0);
  const out = [0];
  let from = 0;
  // sticky: an edit keeps the lines as they were while each still fits (budget + 30 %); from the
  // first line that doesn't, the rest is packed again
  if (prevBreaks?.length && prevBreaks[0] === 0) {
    const prev = prevBreaks.filter((b) => b < score.measureCount);
    for (let i = 0; i < prev.length; i++) {
      const a = prev[i];
      const b = i + 1 < prev.length ? prev[i + 1] : score.measureCount;
      let w = a > 0 ? 0.6 : 0;
      for (let m = a; m < b; m++) w += width(m);
      if (w > budget * 1.3 || b - a > 6) break;
      if (i > 0) out.push(a);
      from = b;
    }
    if (from >= score.measureCount) return out;
    if (from > 0 && out[out.length - 1] !== from) out.push(from);
  }
  let used = 0;
  let count = 0;
  for (let m = from; m < score.measureCount; m++) {
    const w = width(m);
    if (count && (used + w > budget || count >= 6)) {
      out.push(m);
      used = 0;
      count = 0;
    }
    used += w + (count === 0 && m > 0 ? 0.6 : 0); // clef + key at the start of a line
    count++;
  }
  return out;
}
