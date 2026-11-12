/**
 * Counter bumped whenever title page fonts finish loading (fonts.ts), so cached layouts and text
 * measurements made with a fallback font are redone. Kept apart from fonts.ts so drawing code does
 * not pull in the font file URLs.
 */
let epoch = 0;
const listeners = new Set<() => void>();

export function fontEpoch(): number {
  return epoch;
}

export function bumpFontEpoch(): void {
  epoch++;
  listeners.forEach((f) => f());
}

export function onFontEpoch(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
