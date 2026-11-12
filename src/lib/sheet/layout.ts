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
export function systemBreaks(score: Score, budget: number): number[] {
  const ons = onsetsPerMeasure(score);
  const out = [0];
  let used = 0;
  let count = 0;
  for (let m = 0; m < score.measureCount; m++) {
    const w = 1 + 0.3 * ons[m] + (m === 0 ? 1 : 0);
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
