/** Non-React shared state for things that change many times per second (read by the render loop). */
export const liveKeys = new Map<number, string>(); // midi -> color
export const keyMarks = new Map<number, { kind: 'correct' | 'wrong'; until: number }>();

export function flashKey(midi: number, kind: 'correct' | 'wrong', ms = 260): void {
  keyMarks.set(midi, { kind, until: performance.now() + ms });
}

export function currentMarks(): Map<number, 'correct' | 'wrong'> | undefined {
  if (!keyMarks.size) return undefined;
  const now = performance.now();
  const out = new Map<number, 'correct' | 'wrong'>();
  for (const [m, v] of keyMarks) {
    if (v.until < now) keyMarks.delete(m);
    else out.set(m, v.kind);
  }
  return out;
}
