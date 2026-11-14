import { describe, expect, it } from 'vitest';
import {
  PIANO_BLEND,
  blendFills,
  blendLeadCandidates,
  blendRestrikes,
  fuseScore,
  joinFragments,
  octaveFixes,
  packSpecNotes,
  prepareSpecialist,
  riffPassages,
  specNotesFromOutputs,
  unpackSpecNotes,
  type BlendEvidence,
  type PreparedNote,
  type SpecNote,
} from '../../src/lib/music/pianoBlend';
import { addExtraLead, recoverLead } from '../../src/lib/music/leadRecovery';
import { mergeMelody } from '../../src/lib/music/melody';
import { BLEND_LEVELS, blendTuneLine, generateEasy, withoutRestrikes } from '../../src/lib/music/difficulty';
import type { Note } from '../../src/lib/music/types';

let id = 1;
const note = (midi: number, start: number, dur: number, extra: Partial<Note> = {}): Note => ({ id: id++, midi, start, dur, vel: 0.7, hand: 'R', ...extra });
const spec = (midi: number, start: number, dur: number, extra: Partial<SpecNote> = {}): SpecNote => ({ midi, start, dur, vel: 0.7, onsetPeak: 0.9, frameMean: 0.6, ...extra });
const prep = (midi: number, start: number, dur: number, extra: Partial<PreparedNote> = {}): PreparedNote => ({
  ...spec(midi, start, dur),
  relVel: 1,
  bpMean: 0.3,
  bpOn: 0.6,
  matched: false,
  ...extra,
});

/** Basic Pitch evidence: the same values everywhere unless `by` (midi -> value) says otherwise. */
function evidence(o: { mean?: number; onset?: number; rise?: number; meanBy?: Record<number, number>; riseBy?: Record<number, number>; drum?: number } = {}): BlendEvidence {
  return {
    mean: (m) => o.meanBy?.[m] ?? o.mean ?? 0.3,
    onset: () => o.onset ?? 0.6,
    rise: (m) => o.riseBy?.[m] ?? o.rise ?? 0.3,
    ...(o.drum !== undefined ? { drum: () => o.drum! } : {}),
  };
}

describe('piano-model notes', () => {
  it('reads onset peak and frame mean from the output maps, and packs / unpacks them exactly', () => {
    const nFrames = 300;
    const P = 88;
    const frame = new Float32Array(nFrames * P);
    const onset = new Float32Array(nFrames * P);
    const offset = new Float32Array(nFrames * P);
    const velocity = new Float32Array(nFrames * P);
    const k = 60 - 21;
    // one note: frames 100-149 on, an onset peak at 100 (rising/falling over 2 frames), offset at 150
    for (let t = 100; t < 150; t++) frame[t * P + k] = 0.8;
    for (const [t, v] of [[98, 0.2], [99, 0.6], [100, 0.95], [101, 0.6], [102, 0.2]] as const) onset[t * P + k] = v;
    for (const [t, v] of [[146, 0.1], [147, 0.2], [148, 0.4], [149, 0.7], [150, 0.95], [151, 0.7], [152, 0.4], [153, 0.2], [154, 0.1]] as const) offset[t * P + k] = v;
    velocity[100 * P + k] = 0.6;
    const notes = specNotesFromOutputs({ frame, onset, offset, velocity, nFrames, fps: 100 }, 3);
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBe(60);
    expect(notes[0].start).toBeCloseTo(1, 2);
    expect(notes[0].onsetPeak).toBeCloseTo(0.95, 5);
    expect(notes[0].frameMean).toBeGreaterThan(0.7);
    const packed = packSpecNotes(notes);
    expect(packed.length).toBe(6);
    const back = unpackSpecNotes(packed);
    expect(back[0].midi).toBe(60);
    expect(back[0].start).toBeCloseTo(notes[0].start, 6);
    // past the end of the audio: dropped
    expect(specNotesFromOutputs({ frame, onset, offset, velocity, nFrames, fps: 100 }, 0.9)).toHaveLength(0);
  });

  it('joins same-pitch fragments unless Basic Pitch hears a new attack at the join or the later one has a clear onset', () => {
    const a = [spec(64, 1, 0.3), spec(64, 1.33, 0.3, { onsetPeak: 0.4 })];
    expect(joinFragments(a, evidence({ rise: 0.05 }))).toHaveLength(1);
    expect(joinFragments(a, evidence({ rise: 0.05 }))[0].dur).toBeCloseTo(0.63, 6);
    expect(joinFragments(a, evidence({ rise: 0.4 }))).toHaveLength(2);
    // a gap of 60 ms or more is two notes
    expect(joinFragments([spec(64, 1, 0.3), spec(64, 1.37, 0.3, { onsetPeak: 0.4 })], evidence({ rise: 0 }))).toHaveLength(2);
    // a clear onset (at least joinOnset): a repeated note, not a fragment
    expect(joinFragments([spec(64, 1, 0.3), spec(64, 1.33, 0.3, { onsetPeak: PIANO_BLEND.joinOnset })], evidence({ rise: 0 }))).toHaveLength(2);
  });

  it('drops low notes, drum hits, overtones, continuations and very short notes; marks matches', () => {
    const app = [note(48, 0, 2), note(67, 4, 1), note(40, 6, 1, { role: 'bass', hand: 'L' })];
    const ev = { ...evidence({ mean: 0.3, onset: 0.6, rise: 0.05, meanBy: { 60: 0.05, 79: 0.05 } }), drum: (t0: number) => (t0 > 2.9 && t0 < 3.1 ? 200 : 0) };
    const out = prepareSpecialist(
      [
        spec(38, 1, 0.5), // below MIDI 43
        spec(52, 6.1, 0.5), // low, the bass line's pitch class (E): kept (lowBassPc off), dropped with lowBassPc
        spec(50, 6.1, 0.5), // low, Basic Pitch hears it (0.3), not the bass line's pitch class: kept
        spec(72, 3, 0.1), // drum hit: short, weak Basic Pitch onset (overridden below)
        spec(60, 0.5, 0.5), // an octave above the sounding C3 with no Basic Pitch evidence: overtone
        spec(67, 4.4, 0.4), // inside the sounding G4 with no rise: continuation
        spec(67, 4.01, 0.4), // the G4 itself: matched
        spec(74, 5, 0.03), // too short
        spec(76, 5, 0.4), // kept
      ],
      app,
      { ...ev, onset: (m) => (m === 72 ? 0.1 : 0.6) },
    );
    const noRestrike = { ...PIANO_BLEND, restrike: { ...PIANO_BLEND.restrike, enabled: false } };
    expect(prepareSpecialist([spec(67, 4.4, 0.4)], app, ev, noRestrike)).toEqual([]);
    expect(prepareSpecialist([spec(52, 6.1, 0.5)], app, ev, { ...PIANO_BLEND, lowBassPc: true })).toEqual([]);
    // the continuation is kept only as a re-strike candidate (inside), never as a fill or lead note
    expect(out.map((n) => n.midi).sort((a, b) => a - b)).toEqual([50, 52, 67, 67, 76]);
    expect(out.filter((n) => n.inside).map((n) => [n.midi, n.start])).toEqual([[67, 4.4 + PIANO_BLEND.shift]]);
    expect(out.find((n) => n.midi === 67 && !n.inside)!.matched).toBe(true);
    expect(out.find((n) => n.midi === 76)!.matched).toBe(false);
    // shifted by +5 ms
    expect(out.find((n) => n.midi === 76)!.start).toBeCloseTo(5 + PIANO_BLEND.shift, 9);
  });

  it('relative velocity is to the loudest note of its onset cluster', () => {
    const out = prepareSpecialist([spec(72, 1, 0.5, { vel: 0.4 }), spec(76, 1.02, 0.5, { vel: 0.8 }), spec(79, 2, 0.5, { vel: 0.2 })], [], evidence());
    expect(out.map((n) => [n.midi, +n.relVel.toFixed(3)])).toEqual([
      [72, 0.5],
      [76, 1],
      [79, 1],
    ]);
  });
});

describe('lead notes in holes of the tune line', () => {
  const line = [note(72, 0, 0.5), note(76, 2, 0.5), note(74, 2.6, 0.3)];
  it('fills a hole with the highest strong note near the line, capped per second of hole', () => {
    const c = [
      prep(74, 1.0, 0.3), // in the hole (0.5-2.0), near 72..76: yes
      prep(67, 1.0, 0.3), // same cluster, lower: not the highest
      prep(84, 1.4, 0.3), // too far from the line (> 5 semitones)
      prep(75, 1.6, 0.2, { relVel: 0.5 }), // too soft in its cluster
      prep(73, 1.25, 0.2, { matched: true }), // the app has it already
      prep(75, 2.4, 0.2), // between 2.5 and 2.6: gap 0.1 s, not a hole
    ];
    const ins = blendLeadCandidates(c, line);
    expect(ins.map((n) => [n.midi, n.start])).toEqual([[74, 1.0]]);
    expect(ins[0].src).toBe('piano-lead');
    expect(ins[0].role).toBeUndefined();
    // cap: 3 per second of hole (1.5 s -> 4); 6 candidates -> 4 strongest
    const many = [0.6, 0.8, 1.0, 1.2, 1.4, 1.6].map((t, i) => prep(73 + (i % 3), t, 0.15, { onsetPeak: 0.5 + i * 0.08 }));
    const capped = blendLeadCandidates(many, line);
    expect(capped).toHaveLength(4);
    expect(capped.map((n) => n.start)).toEqual([1.0, 1.2, 1.4, 1.6]);
    // an insert never runs into the next one
    for (let i = 1; i < capped.length; i++) expect(capped[i - 1].start + capped[i - 1].dur).toBeLessThan(capped[i].start);
  });

  it('a note Basic Pitch does not hear needs the stem pitch track to agree', () => {
    const c = [prep(74, 1.0, 0.3, { bpMean: 0.02 })];
    expect(blendLeadCandidates(c, line)).toHaveLength(0);
    expect(blendLeadCandidates(c, line, { pitchAgrees: (m) => m % 12 === 2 })).toHaveLength(1);
  });

  it('goes into the arrangement as recovered lead notes do, without touching the tune notes', () => {
    const base = [note(72, 0, 0.5), note(76, 2, 0.5), note(48, 0, 2.5, { hand: 'L' })];
    const ins = blendLeadCandidates([prep(74, 1.0, 0.3), prep(62, 1.0, 0.3, { midi: 62 })], instrumentLineStub(base));
    const out = recoverLead(base, [], 3, { extra: ins, doublesHardOnly: true });
    for (const b of base) expect(out).toContain(b);
    expect(out.filter((n) => n.src === 'piano-lead').map((n) => n.midi)).toEqual([74]);
    // Hard-only when asked (sung songs), doubling a main note an octave away: Hard-only as well
    expect(addExtraLead(base, ins, { hardOnly: true }).find((n) => n.src === 'piano-lead')!.role).toBe('lead');
    const dbl = [...base, note(62, 1.0, 0.5)];
    expect(addExtraLead(dbl, ins, { doublesHardOnly: true }).find((n) => n.src === 'piano-lead')!.role).toBe('lead');
    // nothing inside excluded ranges, nothing already there
    expect(addExtraLead(base, ins, { exclude: [[0.9, 1.2]] })).toBe(base);
    expect(addExtraLead([...base, note(74, 0.98, 0.4)], ins)).toHaveLength(4);
  });
});

/** the line as blendLeadCandidates sees it: the right-hand top notes */
function instrumentLineStub(notes: Note[]): Note[] {
  return notes.filter((n) => n.midi >= 60);
}

describe('octave rule (off by default)', () => {
  const line = [note(72, 0, 0.5), note(64, 0.5, 0.5), note(74, 1, 0.5)];
  const p = [prep(76, 0.5, 0.5, { onsetPeak: 0.9, relVel: 1 })];
  const ev = evidence({ meanBy: { 64: 0.4, 76: 0.3 } });
  it('moves nothing while off', () => {
    expect(PIANO_BLEND.octave.enabled).toBe(false);
    const r = octaveFixes(line, line, p, ev);
    expect(r.moved).toBe(0);
    expect(r.notes).toBe(line);
  });
  it('when on: a tune note the piano model plays only an octave up (and Basic Pitch hears there) moves', () => {
    const rule = { ...PIANO_BLEND, octave: { ...PIANO_BLEND.octave, enabled: true } };
    const r = octaveFixes(line, line, p, ev, rule);
    expect(r.moved).toBe(1);
    expect(r.notes.map((n) => n.midi)).toEqual([72, 76, 74]);
    // not when the piano model also has the note's own pitch, or Basic Pitch barely hears the other octave
    expect(octaveFixes(line, line, [...p, prep(64, 0.52, 0.4)], ev, rule).moved).toBe(0);
    expect(octaveFixes(line, line, p, evidence({ meanBy: { 64: 0.4, 76: 0.1 } }), rule).moved).toBe(0);
  });
});

describe('fills', () => {
  // a tune line on top: C5 then rest then E5
  const tune = [note(72, 0, 1), note(76, 2, 1)];
  const left = [note(48, 0, 3, { hand: 'L' })];
  const app = [...tune, ...left];

  it('adds strong notes at least 3 semitones under the tune, or anywhere where no tune note sounds', () => {
    const p = [
      prep(67, 0.2, 0.3), // under C5: yes
      prep(71, 0.4, 0.3), // one semitone under: no
      prep(79, 0.6, 0.3), // above the tune: no
      prep(84, 1.4, 0.3), // no tune note sounding: yes (may be the top)
      prep(64, 2.2, 0.3, { onsetPeak: 0.2, bpMean: 0.02, relVel: 0.3 }), // weak: no
    ];
    const r = blendFills(app, p, tune, 4);
    expect(r.fills.map((n) => n.midi)).toEqual([67, 84]);
    for (const a of app) expect(r.notes).toContain(a);
    for (const f of r.fills) {
      expect(f.src).toBe('piano');
      expect(f.role).toBeUndefined();
      expect(f.dur).toBeGreaterThanOrEqual(PIANO_BLEND.fill.minDur);
    }
  });

  it('holds a fill to Basic Pitch’s held end, and never into an app note of its pitch', () => {
    const r = blendFills(app, [prep(64, 0.2, 0.1), prep(60, 0.3, 0.2)], tune, 4, { heldEnd: (m, s, e) => (m === 64 ? s + 0.9 : e) });
    expect(r.fills.find((n) => n.midi === 64)!.dur).toBeCloseTo(0.9, 6);
    const r2 = blendFills([...app, note(64, 0.5, 0.5)], [prep(64, 0.2, 0.1)], tune, 4, { heldEnd: (_m, s) => s + 0.9 });
    expect(r2.fills[0].start + r2.fills[0].dur).toBeLessThan(0.5);
    // a fill in a gap of the tune ends where a tune note starts that it would sit on or above
    const gap = blendFills(app, [prep(79, 1.2, 0.3)], tune, 4, { heldEnd: (_m, s) => s + 1.6 });
    expect(gap.fills[0].start + gap.fills[0].dur).toBeCloseTo(2 - 0.005, 6);
    // ...but not one it stays well under
    const under = blendFills(app, [prep(67, 1.2, 0.3)], tune, 4, { heldEnd: (_m, s) => s + 1.6 });
    expect(under.fills[0].dur).toBeCloseTo(1.6, 6);
    // where an app note of its pitch already sounds: nothing
    expect(blendFills([...app, note(64, 0.1, 0.5)], [prep(64, 0.2, 0.3)], tune, 4).fills).toHaveLength(0);
  });

  it('caps the density (4 per second in any 2 s) and the notes per hand in a cluster', () => {
    const dense = Array.from({ length: 20 }, (_, i) => prep(55 + (i % 10), 4 + i * 0.1, 0.2, { onsetPeak: 0.5 + (i % 5) * 0.1 }));
    const r = blendFills(app, dense, tune, 8);
    for (let t = 3; t < 7; t += 0.05) expect(r.fills.filter((n) => n.start >= t && n.start < t + 2).length).toBeLessThanOrEqual(8);
    // one cluster of 8 right-hand candidates with 2 app notes there: at most fill.rh right-hand notes in all
    const appR = [note(84, 5, 1), note(86, 5, 1)];
    const chord = [60, 62, 64, 65, 67, 69, 71, 72].map((m) => prep(m + 12, 5.01, 0.4));
    const r2 = blendFills(appR, chord, [], 8);
    expect(r2.fills.filter((n) => n.hand === 'R').length).toBe(PIANO_BLEND.fill.rh - 2);
  });

  it('fills take their hand from the split the app notes make, without moving the app notes’ hands', () => {
    const notes = [note(72, 0, 1), note(76, 0.5, 1), note(40, 0, 2), note(43, 1, 1)];
    const before = mergeMelody(notes, [], 3);
    const r = blendFills(notes, [prep(50, 0.2, 0.4), prep(64, 1.6, 0.3)], notes.filter((n) => n.midi >= 60), 3);
    const after = mergeMelody(r.notes, [], 3);
    const hands = (ns: Note[]) => ns.filter((n) => !n.src).map((n) => [n.midi, n.start, n.hand]);
    expect(hands(after)).toEqual(hands(before));
    expect(after.find((n) => n.src && n.midi === 50)!.hand).toBe('L');
    expect(after.find((n) => n.src && n.midi === 64)!.hand).toBe('R');
  });

  it('fuse score weights: onset 0.45, Basic Pitch 0.35 (full at 0.25), relative velocity 0.20', () => {
    expect(fuseScore({ onsetPeak: 1, bpMean: 0.25, relVel: 1 })).toBeCloseTo(1, 9);
    expect(fuseScore({ onsetPeak: 0, bpMean: 0, relVel: 0 })).toBe(0);
    expect(fuseScore({ onsetPeak: 1, bpMean: 1, relVel: 0 })).toBeCloseTo(0.8, 9);
  });
});

describe('riff on top (off by default)', () => {
  it('finds runs of sparse tune line with a steady piano-model figure; fills go above the tune there only', () => {
    expect(PIANO_BLEND.riff.enabled).toBe(false);
    const line = [note(72, 0, 4), note(74, 4, 4), note(76, 8, 0.25), note(77, 8.25, 0.25), note(79, 8.5, 0.25), note(81, 8.75, 0.25)];
    const riff = Array.from({ length: 32 }, (_, i) => prep(79 + (i % 4), i * 0.25, 0.2, { onsetPeak: 0.9, bpMean: 0.3, relVel: 1 }));
    const r = riffPassages(line, riff, 10);
    expect(r).toEqual([[0, 8]]);
    // with the passage: the riff's notes over the held tune note are kept
    const withRiff = blendFills(line, riff.filter((p) => p.start < 4), line, 10, {}, { riff: r });
    const without = blendFills(line, riff.filter((p) => p.start < 4), line, 10);
    expect(withRiff.fills.length).toBeGreaterThan(without.fills.length);
    expect(without.fills.every((n) => n.midi <= 69)).toBe(true);
  });
});

describe('re-strikes', () => {
  it('splits an app note where the piano model hears it struck again, keeping its hand and role', () => {
    const held = note(70, 1, 1, { role: 'lead' });
    const bass = note(40, 1, 1, { hand: 'L', role: 'bass' });
    const other = note(64, 1, 1);
    const p = [
      prep(70, 1.5, 0.3, { matched: false, inside: true }), // re-strike of the held B♭4
      prep(40, 1.5, 0.3, { inside: true }), // the bass line is not split
      prep(64, 1.05, 0.3, { inside: true }), // too soon after the note's start (minIn)
      prep(64, 1.96, 0.3, { inside: true }), // too close to its end (minLeft)
    ];
    const r = blendRestrikes([held, bass, other], p);
    expect(r.split).toBe(1);
    expect(r.used).toEqual(new Set([p[0]]));
    const pieces = r.notes.filter((n) => n.midi === 70);
    expect(pieces.map((n) => [+n.start.toFixed(3), +(n.start + n.dur).toFixed(3), n.role, n.src ?? ''])).toEqual([
      [1, 1.495, 'lead', ''],
      [1.5, 2, 'lead', 'restrike'],
    ]);
    expect(pieces[0].id).toBe(held.id);
    expect(pieces[1].id).not.toBe(held.id);
    expect(r.notes).toContain(bass);
    expect(r.notes).toContain(other);
    // weak onsets or quiet notes do not split; nor when the rule is off
    expect(blendRestrikes([held], [prep(70, 1.5, 0.3, { onsetPeak: 0.3, inside: true })]).split).toBe(0);
    expect(blendRestrikes([held], [prep(70, 1.5, 0.3, { relVel: 0.5, inside: true })]).split).toBe(0);
    expect(blendRestrikes([held], [p[0]], { ...PIANO_BLEND, restrike: { ...PIANO_BLEND.restrike, enabled: false } }).notes).toEqual([held]);
  });

  it('re-strike candidates are never fills or lead inserts', () => {
    const line = [note(72, 0, 1), note(76, 3, 1)];
    const inside = prep(60, 1.5, 0.3, { inside: true });
    expect(blendFills(line, [inside], line, 5).fills).toEqual([]);
    expect(blendLeadCandidates([prep(74, 1.5, 0.3, { inside: true })], line)).toEqual([]);
  });

  it('Easy joins the pieces back into one held note', () => {
    const a = note(70, 1, 0.495);
    const b = note(70, 1.5, 0.5, { src: 'restrike' });
    const c = note(70, 3, 0.5, { src: 'restrike' }); // not right after a piece of its pitch: kept
    const out = withoutRestrikes([a, b, c, note(60, 1, 1)]);
    expect(out.filter((n) => n.midi === 70).map((n) => [n.start, n.dur])).toEqual([[1, 1], [3, 0.5]]);
    expect(a.dur).toBe(0.495); // the input is not changed
    const tempo = { bpm: 120, confidence: 1, beatsPerBar: 4, downbeatIndex: 0, beats: Array.from({ length: 12 }, (_, i) => i * 0.5) };
    const easy = generateEasy([a, b, note(48, 1, 1, { hand: 'L' })], tempo, 6);
    expect(easy.filter((n) => n.midi === 70)).toHaveLength(1);
  });
});

describe('fills and the Easy / Medium tune line', () => {
  it('fills join the tune line only where the line without them has no note', () => {
    expect(BLEND_LEVELS.fillsInTune).toBe('holes');
    // a tune C5 D5 E5 with a rest at 1-2 s; a run of louder fills under it, and one fill in the rest
    const tune = [note(72, 0, 1, { vel: 0.5 }), note(74, 2, 1, { vel: 0.5 }), note(76, 3, 1, { vel: 0.5 })];
    const fills = [note(69, 0, 1, { src: 'piano', vel: 1 }), note(71, 1.1, 0.8, { src: 'piano' }), note(67, 2, 1, { src: 'piano', vel: 1 })];
    const all: [number, number][] = [[-Infinity, Infinity]];
    const line = blendTuneLine([...tune, ...fills], all);
    for (const t of tune) expect(line.map((n) => n.id)).toContain(t.id);
    expect(line.filter((n) => n.src === 'piano').map((n) => n.midi)).toEqual([71]);
  });
});
