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

  it('keeps holding over a note struck below when the stem says it is backing', () => {
    const top = note(79, 0, 0.3);
    const below = note(74, 0.5, 0.2, 0.3);
    const opts = { heldEnd: heldTo(new Map([[top, 1.2]])), onset: (n: Note) => (n === below ? 0.8 : 0.3) };
    const end = (out: Note[]) => out.find((n) => n.id === top.id)!.start + out.find((n) => n.id === top.id)!.dur;
    // the struck note is passed to the callback
    const seen: Note[] = [];
    expect(end(sustainTuneLine([...bass(), top, below], 8, { ...opts, continues: (_n, x) => (seen.push(x), true) }))).toBeCloseTo(1.2);
    expect(seen).toContain(below);
    expect(end(sustainTuneLine([...bass(), top, below], 8, { ...opts, continues: () => false }))).toBeLessThanOrEqual(0.5);
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

  it('leaves notes below the tune register alone', () => {
    const low = [note(55, 0, 0.3), note(57, 1, 0.3)];
    expect(sustainTuneLine([...bass(), ...low], 8, { heldEnd: heldTo(new Map()) })).toEqual([...bass().map((n) => expect.objectContaining({ midi: n.midi })), ...low]);
  });

  it('the step-down stop only looks at notes starting near or after the end', () => {
    const top = note(79, 2, 0.3);
    const earlier = note(74, 0.5, 0.2, 0.3); // a clear note long before: no stop
    const r = sustainTuneLine([...bass(), note(81, 0, 0.3), earlier, top], 8, { heldEnd: heldTo(new Map()), onset: () => 0.8 });
    expect(r.find((n) => n.id === top.id)!.start + r.find((n) => n.id === top.id)!.dur).toBeGreaterThan(3);
  });
});

describe('bass re-detections', () => {
  it('folds a same-pitch bass note without a new attack into the note before', async () => {
    const { foldBassRestrikes } = await import('../../src/lib/music/cleanup');
    const a = note(40, 0, 0.4);
    const b = note(40, 0.45, 0.4); // the kick fired the onset head; the bass note rang on
    const c = note(40, 1.5, 0.3); // after a rest: a new note
    const high = note(52, 0.45, 0.4); // not bass
    const out = foldBassRestrikes([a, b, c, high], (n) => (n === b ? 0.02 : 0.5));
    expect(out.filter((n) => n.midi === 40).map((n) => [n.start, +(n.start + n.dur).toFixed(3)])).toEqual([
      [0, 0.85],
      [1.5, 1.8],
    ]);
    expect(out).toContain(high);
    // re-struck (the frame activation rises again): kept apart
    expect(foldBassRestrikes([a, b], () => 0.3)).toHaveLength(2);
    expect(foldBassRestrikes([note(52, 0, 0.4), note(52, 0.45, 0.4)], () => 0)).toHaveLength(2);
  });
});

describe('Full song pipeline', () => {
  it('holds a tune note while the frame posterior stays above the off level, not with a sung line', async () => {
    const { accompFromRaw, EXTRACTION_PRESETS } = await import('../../src/lib/transcription/pipeline');
    const { BP_N_PITCHES, timeToFrame } = await import('../../src/lib/transcription/constants');
    const n = timeToFrame(5);
    const frames = new Float32Array(n * BP_N_PITCHES);
    const onsets = new Float32Array(n * BP_N_PITCHES);
    const ev = (midi: number, a: number, b: number) => ({ midi, startFrame: timeToFrame(a), endFrame: timeToFrame(b), amplitude: 0.8, onset: 0.9 });
    const set = (midi: number, a: number, b: number, v: number) => {
      for (let t = timeToFrame(a); t < timeToFrame(b); t++) frames[t * BP_N_PITCHES + midi - 21] = v;
    };
    set(40, 0, 4, 0.6);
    set(76, 0, 0.4, 0.6);
    set(76, 0.4, 1.4, 0.25); // still heard, under the detection threshold
    set(79, 1.5, 1.9, 0.6);
    const raw = [ev(40, 0, 4), ev(76, 0, 0.4), ev(79, 1.5, 1.9)];
    const rms = new Float32Array(600).fill(0.3);
    const ctx = { frames, onsets, nFrames: n };
    const r = accompFromRaw(raw, raw, rms, EXTRACTION_PRESETS.mix, 5, ctx);
    const e5 = r.notes.find((x) => x.midi === 76)!;
    expect(e5.start + e5.dur).toBeGreaterThan(1.3);
    expect(r.main.find((x) => x.midi === 76)!.dur).toBeLessThan(0.5); // the tempo still sees the detected notes
    const sung = accompFromRaw(raw, raw, rms, EXTRACTION_PRESETS.mix, 5, ctx, { melody: [note(64, 3, 0.5, 0.7, { role: 'melody' })] });
    expect(sung.notes.find((x) => x.midi === 76)!.dur).toBeLessThan(0.5);
    // a "Full song" re-detection whose main pass is as sensitive as the lead pass (no extra pass):
    // still held; the presets without the lead pass are not
    const sensitive = { ...EXTRACTION_PRESETS.mix, frameThreshold: 0.3, minNoteMs: 50 };
    const s2 = accompFromRaw(raw, raw, rms, sensitive, 5, ctx);
    expect(s2.notes.find((x) => x.midi === 76)!.start + s2.notes.find((x) => x.midi === 76)!.dur).toBeGreaterThan(1.3);
    const piano = accompFromRaw(raw, raw, rms, { ...EXTRACTION_PRESETS.mix, leadPass: undefined }, 5, ctx);
    expect(piano.notes.find((x) => x.midi === 76)!.dur).toBeLessThan(0.5);
  });

  it('folds a kick-chopped bass note, with or without the lead pass', async () => {
    const { accompFromRaw, EXTRACTION_PRESETS } = await import('../../src/lib/transcription/pipeline');
    const { BP_N_PITCHES, timeToFrame } = await import('../../src/lib/transcription/constants');
    const n = timeToFrame(5);
    const frames = new Float32Array(n * BP_N_PITCHES);
    const onsets = new Float32Array(n * BP_N_PITCHES);
    for (let t = timeToFrame(0); t < timeToFrame(2.2); t++) frames[t * BP_N_PITCHES + 40 - 21] = 0.6; // one held bass note
    const ev = (midi: number, a: number, b: number) => ({ midi, startFrame: timeToFrame(a), endFrame: timeToFrame(b), amplitude: 0.8, onset: 0.9 });
    const raw = [ev(40, 0, 1), ev(40, 1.1, 2.2)]; // the kick fired the onset head at 1.1
    const rms = new Float32Array(600).fill(0.3);
    const ctx = { frames, onsets, nFrames: n };
    const bassOf = (r: { notes: Note[] }) => r.notes.filter((x) => x.midi === 40);
    expect(bassOf(accompFromRaw(raw, raw, rms, EXTRACTION_PRESETS.mix, 5, ctx))).toHaveLength(1);
    expect(bassOf(accompFromRaw(raw, undefined, rms, EXTRACTION_PRESETS.mix, 5, ctx))).toHaveLength(1);
    expect(bassOf(accompFromRaw(raw, raw, rms, { ...EXTRACTION_PRESETS.mix, leadPass: undefined }, 5, ctx))).toHaveLength(2);
  });

  it('re-detection passes the stored onsets on (the lead onset test)', async () => {
    const { storedContext } = await import('../../src/lib/transcription/pipeline');
    const frames = new Uint8Array(88);
    const onsets = new Uint8Array(88);
    const drums = new Uint8Array(4);
    const ctx = storedContext({ frames, onsets, nFrames: 1, drums } as unknown as Parameters<typeof storedContext>[0]);
    expect(ctx.onsets).toBe(onsets);
    expect(ctx.frames).toBe(frames);
    expect(ctx.drums).toBe(drums);
  });

  it('closes a short gap to the next tune note unless the stem hears another pitch or goes quiet there', () => {
    const a = note(76, 0, 0.3);
    const b = note(79, 0.45, 0.3); // 0.15 s gap
    const c = note(77, 1.5, 0.3); // after a rest
    const notes = [note(40, 0, 4, 0.6, { hand: 'L' }), a, b, c];
    const quiet = () => ({ voiced: 0, agree: 0, dropDb: 0 }); // no clear pitch in the gap
    const run = (gapCue: (midi: number, t0: number, t1: number) => { voiced: number; agree: number; dropDb: number }, extra: Note[] = []) =>
      sustainTuneLine([...notes, ...extra], 8, { heldEnd: (n) => n.start + n.dur, gapCue });
    const out = run(quiet);
    const end = (ns: Note[], id: number) => ns.find((n) => n.id === id)!.start + ns.find((n) => n.id === id)!.dur;
    expect(end(out, a.id)).toBeCloseTo(0.45 - SUSTAIN.gap);
    expect(end(out, b.id)).toBeCloseTo(0.75); // 0.75 s gap: longer than closeGap, left alone
    // the stem's pitch track at the note's pitch class (an octave down counts) in the gap: closed
    expect(end(run(() => ({ voiced: 10, agree: 8, dropDb: 2 })), a.id)).toBeCloseTo(0.45 - SUSTAIN.gap);
    // ...at another pitch: the tune moved on or the backing fills a rest
    expect(run(() => ({ voiced: 10, agree: 1, dropDb: 2 })).find((n) => n.id === a.id)).toBe(a);
    // the stem falls silent in the gap: a real rest
    expect(run(() => ({ voiced: 0, agree: 0, dropDb: 20 })).find((n) => n.id === a.id)).toBe(a);
    // the same pitch struck again in the gap: not held over that new attack
    const again = note(76, 0.36, 0.05, 0.2);
    expect(end(run(quiet, [again]), a.id)).toBeLessThanOrEqual(0.36);
    // without the stem's pitch track (no separation) nothing is closed
    expect(sustainTuneLine(notes, 8, { heldEnd: (n) => n.start + n.dur }).find((n) => n.id === a.id)).toBe(a);
  });
});
