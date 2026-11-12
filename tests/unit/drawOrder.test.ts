import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHORD_WINDOW, PianoRollRenderer, noteDrawOrder } from '../../src/lib/render/renderer';
import { DEFAULT_VISUAL, type VisualSettings } from '../../src/lib/render/settings';
import type { Note } from '../../src/lib/music/types';

let nextId = 1;
const note = (midi: number, start: number, dur: number, hand: 'L' | 'R' = 'R'): Note => ({ id: nextId++, midi, start, dur, vel: 0.8, hand });

/** A 2D context that ignores drawing but records the labels it is asked to paint, in order. */
function fakeContext(labels: string[]) {
  const gradient = { addColorStop() {} };
  const target: Record<string | symbol, unknown> = {
    fillText: (text: string) => labels.push(text),
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    filter: 'none',
  };
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : () => undefined),
    set: (t, k, v) => ((t[k] = v), true),
  });
}
class FakeCanvas {
  width: number;
  height: number;
  readonly labels: string[] = [];
  constructor(w = 1, h = 1) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    return fakeContext(this.labels);
  }
}

const g = globalThis as { OffscreenCanvas?: unknown };
const hadOffscreen = 'OffscreenCanvas' in g;
const prevOffscreen = g.OffscreenCanvas;
beforeAll(() => {
  g.OffscreenCanvas = FakeCanvas;
});
afterAll(() => {
  if (hadOffscreen) g.OffscreenCanvas = prevOffscreen;
  else delete g.OffscreenCanvas;
});

const visual: VisualSettings = {
  ...DEFAULT_VISUAL,
  range: 'auto',
  fallingGlow: 0,
  labels: { ...DEFAULT_VISUAL.labels, style: 'letter', accidentals: 'sharps', minNoteHeight: 1 },
  background: { ...DEFAULT_VISUAL.background, kind: 'color' },
};

// a long, still-held C#5 with newer C5 and D5 notes falling onto the neighbouring keys
const scene = () => {
  const held = note(73, 0, 4);
  const c = note(72, 1.0, 0.5);
  const d = note(74, 1.5, 0.5);
  return { held, c, d, notes: [d, held, c] };
};

describe('falling-note draw order', () => {
  it('paints newer notes over older ones, black over white only within a chord', () => {
    const { held, c, d, notes } = scene();
    const sorted = [...notes].sort((a, b) => a.start - b.start);
    expect(noteDrawOrder(sorted).notes.map((n) => n.id)).toEqual([held.id, c.id, d.id]);

    // chord (rolled by a few ms, black key first): white keys first, then the black key
    const g5 = note(79, 2.0, 1);
    const gs5 = note(80, 2.0 - CHORD_WINDOW / 4, 1);
    const a5 = note(81, 2.0 + CHORD_WINDOW / 4, 1);
    const later = note(78, 2.0 + CHORD_WINDOW * 2, 1); // F#5: a new group, so on top of all of them
    const chord = [g5, gs5, a5, later].sort((a, b) => a.start - b.start);
    const order = noteDrawOrder(chord);
    expect(order.notes.map((n) => n.id)).toEqual([g5.id, a5.id, gs5.id, later.id]);
    // group onsets never decrease (the renderer binary searches them)
    for (let i = 1; i < order.groupStart.length; i++) expect(order.groupStart[i]).toBeGreaterThanOrEqual(order.groupStart[i - 1]);

    // a re-struck note (same pitch, starts before the old one ends) goes over the old one
    const e1 = note(76, 0.2, 3);
    const e2 = note(76, 1.0, 1);
    expect(noteDrawOrder([e1, e2]).notes).toEqual([e1, e2]);
  });

  it('renders (live view and video export share this path) in that order, and hit-tests the top note', () => {
    const { held, c, notes } = scene();
    const canvas = new FakeCanvas();
    const r = new PianoRollRenderer(canvas as unknown as OffscreenCanvas, visual);
    r.setNotes(notes, [], null);
    r.resize(1920, 1080);
    r.render({ time: 0.5 });
    const noteLabels = canvas.labels.filter((t) => ['C', 'C♯', 'D'].includes(t));
    expect(noteLabels).toEqual(['C♯', 'C', 'D']);

    // a point where the held black-key note and the newer C overlap picks the newer C
    const rc = r.noteRect(c, 0.5)!;
    const rh = r.noteRect(held, 0.5)!;
    const x = (Math.max(rc.x, rh.x) + Math.min(rc.x + rc.w, rh.x + rh.w)) / 2;
    expect(x).toBeGreaterThan(rh.x);
    expect(x).toBeLessThan(rc.x + rc.w);
    expect(r.hitTest(x, rc.y + rc.h / 2, 0.5)?.note.id).toBe(c.id);
  });
});
