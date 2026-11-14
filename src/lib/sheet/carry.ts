/**
 * Mark ids and carrying Hard's markings over to Easy and Medium. Kept apart from marks.ts (which
 * needs the sheet engine) so the song helpers (lib/songs.ts) load without it.
 */
import type { Arrangement, Note, SheetMark } from '../music/types';

/** A new marking id: 'm' + 8 base-36 characters (random; never the note-id counter). */
export function newMarkId(): string {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return 'm' + [...b].map((x) => (x % 36).toString(36)).join('');
}

/**
 * Carries the markings of Hard over to a level derived from it: fingering and articulations to
 * notes of the same pitch and hand starting within 1 ms; dynamics, hairpins and words by position;
 * slurs only when both their notes match; pedal only when it was edited on the sheet. Pins are not
 * copied (the derived notes are written on their own level's grid).
 */
export function carryMarks(hard: Arrangement, derived: Arrangement): Arrangement {
  const key = (n: Note) => `${n.hand}|${n.midi}`;
  const byKey = new Map<string, Note[]>();
  for (const n of derived.notes) {
    let a = byKey.get(key(n));
    if (!a) byKey.set(key(n), (a = []));
    a.push(n);
  }
  const match = new Map<number, number>(); // hard id → derived id
  const patch = new Map<number, Partial<Note>>();
  for (const h of hard.notes) {
    const d = byKey.get(key(h))?.find((x) => Math.abs(x.start - h.start) < 0.001);
    if (!d) continue;
    match.set(h.id, d.id);
    if (!h.finger && !h.art?.length) continue;
    patch.set(d.id, {
      ...(h.finger ? { finger: h.finger } : {}),
      ...(h.art?.length ? { art: [...h.art], ...(h.artBase ? { artBase: { ...h.artBase } } : {}) } : {}),
    });
  }
  const notes = patch.size ? derived.notes.map((n) => (patch.has(n.id) ? { ...n, ...patch.get(n.id) } : n)) : derived.notes;
  const marks: SheetMark[] = [];
  for (const m of hard.marks ?? []) {
    if (m.kind === 'slur') {
      const from = match.get(m.from);
      const to = match.get(m.to);
      if (from !== undefined && to !== undefined) marks.push({ ...m, id: newMarkId(), from, to });
    } else marks.push({ ...m, id: newMarkId() });
  }
  const out: Arrangement = { ...derived, notes };
  if (marks.length) out.marks = marks;
  if (hard.pedalEdited) {
    out.pedal = hard.pedal.map((p) => ({ ...p }));
    out.pedalEdited = true;
  }
  if (hard.showPedal) out.showPedal = true;
  return out;
}

