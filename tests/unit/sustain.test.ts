import { describe, expect, it } from 'vitest';
import { SUSTAIN, sustainTuneLine } from '../../src/lib/music/sustain';
import type { Note } from '../../src/lib/music/types';

let id = 1;
const note = (midi: number, start: number, dur: number, vel = 0.7, extra: Partial<Note> = {}): Note => ({ id: id++, midi, start, dur, vel, hand: 'R', ...extra });
// the model hears every note until `until` (or 1 s past its end)
const heldTo = (until: Map<Note, number>) => (n: Note, limit: number) => Math.min(limit, until.get(n) ?? n.start + n.dur + 1);

describe('held tune line', () => {
  const bass = () => [note(40, 0, 4, 0.6), note(43, 4, 4, 0.6)];

  it('holds the tune line notes up to the next line note, not the others', () => {
    const a = note(76, 0, 0.3);
    const b = note(79, 1, 0.3);
    const c = note(77, 2, 0.3);
    const inner = note(64, 0.5, 0.2, 0.3); // inner voice under the tune
    const notes = [...bass(), a, b, c, inner];
    const out = sustainTuneLine(notes, 8, { heldEnd: heldTo(new Map([[a, 0.9]])) });
    const by = (m: number) => out.find((n) => n.midi === m)!;
    expect(by(76).start + by(76).dur).toBeCloseTo(0.9); // as long as the model hears it
    expect(by(79).start + by(79).dur).toBeCloseTo(2 - SUSTAIN.gap); // capped at the next line note
    expect(by(64)).toBe(inner);
    expect(out.find((n) => n.midi === 40)).toBe(notes[0]);
  });

  it('stops at the next note of the same pitch and at a clear new note a little below', () => {
    const a = note(76, 0, 0.3);
    const again = note(76, 0.6, 0.3);
    const out = sustainTuneLine([...bass(), a, again], 8, { heldEnd: heldTo(new Map()) });
    expect(out.find((n) => n.id === a.id)!.dur).toBeCloseTo(0.6 - SUSTAIN.gap);
    const top = note(79, 0, 0.3);
    const below = note(74, 0.5, 0.2, 0.3); // the tune stepping down while the old note still rings
    const r = sustainTuneLine([...bass(), top, below], 8, { heldEnd: heldTo(new Map()), onset: (n) => (n === below ? 0.8 : 0.3) });
    expect(r.find((n) => n.id === top.id)!.start + r.find((n) => n.id === top.id)!.dur).toBeLessThanOrEqual(0.5);
  });

  it('folds same-pitch line notes without a new attack into one held note', () => {
    const a = note(79, 0, 0.5);
    const b = note(79, 0.51, 0.5);
    const c = note(77, 1.2, 0.3);
    const flat = sustainTuneLine([...bass(), a, b, c], 8, { heldEnd: (n) => n.start + n.dur, rise: () => 0.02 });
    expect(flat.filter((n) => n.midi === 79)).toHaveLength(1);
    expect(flat.find((n) => n.midi === 79)!.dur).toBeCloseTo(1.01);
    const struck = sustainTuneLine([...bass(), a, b, c], 8, { heldEnd: (n) => n.start + n.dur, rise: () => 0.3 });
    expect(struck.filter((n) => n.midi === 79)).toHaveLength(2);
    // a recovered Hard-only note is not extended into by a main note's fold the other way round
    const lead = note(79, 0, 0.5, 0.7, { role: 'lead' });
    const r = sustainTuneLine([...bass(), lead, b, c], 8, { heldEnd: (n) => n.start + n.dur, rise: () => 0.02 });
    expect(r.filter((n) => n.midi === 79)).toHaveLength(2);
  });

  it('leaves notes below the tune register and excluded ranges alone', () => {
    const low = [note(55, 0, 0.3), note(57, 1, 0.3)];
    expect(sustainTuneLine([...bass(), ...low], 8, { heldEnd: heldTo(new Map()) })).toEqual([...bass().map((n) => expect.objectContaining({ midi: n.midi })), ...low]);
    const a = note(76, 0, 0.3);
    const b = note(79, 1, 0.3);
    const out = sustainTuneLine([...bass(), a, b], 8, { heldEnd: heldTo(new Map()), exclude: [[-1, 0.5]] });
    expect(out.find((n) => n.id === a.id)).toBe(a);
  });
});
