import { useEffect, useState, type RefObject } from 'react';

/**
 * A number that goes up each time the browser gives the canvas's 2D context back after losing it
 * (a GPU reset, iOS memory pressure, a backgrounded tab). The canvas is blank then: put the number
 * in the drawing effect's dependencies so the picture is drawn again.
 */
export function useCanvasRestored(ref: RefObject<HTMLCanvasElement | null>): number {
  const [restored, setRestored] = useState(0);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const onRestored = () => setRestored((n) => n + 1);
    c.addEventListener('contextrestored', onRestored);
    return () => c.removeEventListener('contextrestored', onRestored);
  }, [ref]);
  return restored;
}
