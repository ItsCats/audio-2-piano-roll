import type { Hand, Note, PedalRange } from '../music/types';

export type PlayEvent =
  | { t: number; kind: 'on'; midi: number; vel: number; tag: number }
  | { t: number; kind: 'off'; midi: number; tag: number }
  | { t: number; kind: 'pedal'; down: boolean };

const ORDER = { off: 0, pedal: 1, on: 2 } as const;

/** Chronological event list. At equal times: note-offs, then pedal, then note-ons. */
export function buildEvents(notes: Note[], pedal: PedalRange[], hands: Record<Hand, boolean>): PlayEvent[] {
  const ev: PlayEvent[] = [];
  for (const n of notes) {
    if (!hands[n.hand]) continue;
    ev.push({ t: n.start, kind: 'on', midi: n.midi, vel: n.vel, tag: n.id });
    ev.push({ t: n.start + n.dur, kind: 'off', midi: n.midi, tag: n.id });
  }
  for (const p of pedal) {
    ev.push({ t: p.start, kind: 'pedal', down: true });
    ev.push({ t: p.end, kind: 'pedal', down: false });
  }
  ev.sort((a, b) => a.t - b.t || ORDER[a.kind] - ORDER[b.kind]);
  return ev;
}

export function firstEventIndexAtOrAfter(events: PlayEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function pedalDownAt(pedal: PedalRange[], t: number): boolean {
  return pedal.some((p) => p.start <= t && p.end > t);
}
