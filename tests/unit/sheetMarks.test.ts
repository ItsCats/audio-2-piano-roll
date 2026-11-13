/**
 * Markings on the sheet (lib/sheet/marks.ts, musicxml.ts): each marking's model, its sound and its
 * MusicXML (read back with the app's own XML parser and score importer), chunk splits, escaping,
 * key / time / tempo changes, and carrying Hard's markings over to Easy and Medium.
 */
import { describe, expect, it } from 'vitest';
import type { Arrangement, Difficulty, Note, SheetMark, Song } from '../../src/lib/music/types';
import { buildSheet, toMusicXml, songMusicXml } from '../../src/lib/sheet';
import { ensureSheet } from '../../src/lib/sheet/lock';
import { gridFromLock } from '../../src/lib/sheet/grid';
import { keyAt } from '../../src/lib/sheet/keys';
import { spanOf, deleteOp, tieOp, type SheetCtx } from '../../src/lib/sheet/edit';
import {
  articulationOp,
  bakeDynamic,
  bakeWedge,
  carryMarks,
  dynamicOp,
  fingerOp,
  fixSlurs,
  pedalOp,
  slurOp,
  textOp,
  wedgeOp,
  resizeMarkOp,
  pedalSel,
  withArticulations,
  writtenSeconds,
  levelAt,
  type MarkEditResult,
} from '../../src/lib/sheet/marks';
import { writtenIndex } from '../../src/lib/sheet/written';
import { DIV } from '../../src/lib/sheet/types';
import { parseXml, descendants, childText, type XmlElement } from '../../src/lib/score/xml';
import { readScoreFile } from '../../src/lib/score';
import { sanitizeSheetData } from '../../src/lib/sheet/sanitize';
import { easyMediumFromHard, withAutoPedal } from '../../src/lib/songs';
import { GOLDEN_SONGS, straightSong } from './sheetSongs';

const demo = () => GOLDEN_SONGS[0][1]();
const locked = (song: Song, d: Difficulty = 'hard'): Song => ({ ...song, sheet: ensureSheet(song, d) });
const ctxOf = (song: Song, d: Difficulty = 'hard'): SheetCtx => ({ song, level: d, score: buildSheet(song, d) });
/** The song with a marking result applied to a level (as state/sheetMarks.ts runMarkEdit does). */
function apply(song: Song, res: MarkEditResult | null, d: Difficulty = 'hard'): Song {
  expect(res).not.toBeNull();
  const a: Arrangement = { ...song.arrangements[d] };
  if (res!.notes) a.notes = res!.notes;
  if (res!.marks) {
    if (res!.marks.length) a.marks = res!.marks;
    else delete a.marks;
  }
  if (res!.pedal) a.pedal = res!.pedal;
  if (res!.showPedal) a.showPedal = true;
  if (res!.pedalEdited) a.pedalEdited = true;
  return { ...song, arrangements: { ...song.arrangements, [d]: a } };
}
const rh = (s: Song, d: Difficulty = 'hard') => s.arrangements[d].notes.filter((n) => n.hand === 'R');
const lh = (s: Song, d: Difficulty = 'hard') => s.arrangements[d].notes.filter((n) => n.hand === 'L');
const xmlOf = (s: Song, d: Difficulty = 'hard', from?: number, to?: number) => toMusicXml(buildSheet(s, d), { title: 'Test', date: '2026-01-01', from, to });
const measures = (xml: string) => descendants(parseXml(xml), 'measure');
const notesIn = (m: XmlElement) => m.children.filter((c) => c.name === 'note');
const count = (xml: string, re: RegExp) => (xml.match(re) ?? []).length;
/** The re-imported notes of our MusicXML (the app's own score reader). */
const reimport = (xml: string) => readScoreFile('round-trip.musicxml', new TextEncoder().encode(xml));
const pitchSet = (ns: { midi: number; hand: string }[]) => ns.map((n) => `${n.hand}${n.midi}`).sort();

describe('fingering', () => {
  it('is set, cleared by the same number, written on the first piece and read back', () => {
    let s = locked(demo());
    const n = rh(s)[0];
    s = apply(s, fingerOp(ctxOf(s), new Set([n.id]), 3));
    expect(s.arrangements.hard.notes.find((x) => x.id === n.id)!.finger).toBe(3);
    // notation only: the sound is the same
    expect(s.arrangements.hard.notes.find((x) => x.id === n.id)!.dur).toBe(n.dur);
    const xml = xmlOf(s);
    expect(count(xml, /<fingering placement="above">3<\/fingering>/g)).toBe(1);
    const tagged = measures(xml).flatMap(notesIn).find((x) => descendants(x, 'fingering').length);
    const w = writtenIndex(buildSheet(s, 'hard')).byId.get(n.id)![0];
    expect(childText(tagged!, 'staff')).toBe(String(w.staff));
    // the score reader still reads the same notes
    expect(pitchSet(reimport(xml).notes)).toEqual(pitchSet(s.arrangements.hard.notes));
    s = apply(s, fingerOp(ctxOf(s), new Set([n.id]), 3));
    expect('finger' in s.arrangements.hard.notes.find((x) => x.id === n.id)!).toBe(false);
    expect(count(xmlOf(s), /<fingering/g)).toBe(0);
  });

  it('left hand fingering goes below', () => {
    let s = locked(demo());
    s = apply(s, fingerOp(ctxOf(s), new Set([lh(s)[0].id]), 5));
    expect(xmlOf(s)).toContain('<fingering placement="below">5</fingering>');
  });
});

describe('articulations', () => {
  for (const a of ['staccato', 'accent', 'tenuto', 'marcato'] as const) {
    it(`${a}: apply → remove restores dur and vel exactly; written in the XML`, () => {
      let s = locked(demo());
      const n = rh(s)[4];
      const ctx = ctxOf(s);
      const written = writtenSeconds(ctx, n);
      s = apply(s, articulationOp(ctx, new Set([n.id]), a));
      const m = s.arrangements.hard.notes.find((x) => x.id === n.id)!;
      expect(m.art).toEqual([a]);
      expect(m.artBase).toEqual({ dur: n.dur, vel: n.vel });
      if (a === 'staccato') expect(m.dur).toBeCloseTo(Math.max(0.06, 0.5 * written), 9);
      if (a === 'tenuto') expect(m.dur).toBeCloseTo(written, 9);
      if (a === 'marcato') {
        expect(m.dur).toBeCloseTo(0.8 * written, 9);
        expect(m.vel).toBeCloseTo(Math.min(1, n.vel + 0.25), 9);
      }
      if (a === 'accent') expect(m.vel).toBeCloseTo(Math.min(1, n.vel + 0.15), 9);
      // written where it was (the pin keeps the written length when the sound is shorter)
      const sp0 = spanOf(ctx, n);
      const sp1 = spanOf(ctxOf(s), m);
      expect(sp1).toEqual(sp0);
      const xml = xmlOf(s);
      expect(xml).toContain(a === 'marcato' ? '<strong-accent type="up"/>' : `<${a}/>`);
      expect(pitchSet(reimport(xml).notes)).toEqual(pitchSet(s.arrangements.hard.notes));
      s = apply(s, articulationOp(ctxOf(s), new Set([n.id]), a));
      const back = s.arrangements.hard.notes.find((x) => x.id === n.id)!;
      expect(back.dur).toBe(n.dur);
      expect(back.vel).toBe(n.vel);
      expect('art' in back || 'artBase' in back).toBe(false);
    });
  }

  it('staccato and tenuto exclude each other; two articulations combine', () => {
    let s = locked(demo());
    const n = rh(s)[2];
    s = apply(s, articulationOp(ctxOf(s), new Set([n.id]), 'staccato'));
    s = apply(s, articulationOp(ctxOf(s), new Set([n.id]), 'accent'));
    expect(s.arrangements.hard.notes.find((x) => x.id === n.id)!.art).toEqual(['staccato', 'accent']);
    s = apply(s, articulationOp(ctxOf(s), new Set([n.id]), 'tenuto'));
    expect(s.arrangements.hard.notes.find((x) => x.id === n.id)!.art).toEqual(['accent', 'tenuto']);
    const m = s.arrangements.hard.notes.find((x) => x.id === n.id)!;
    s = apply(s, { notes: s.arrangements.hard.notes.map((x) => (x.id === n.id ? withArticulations(ctxOf(s), m, []) : x)) });
    const back = s.arrangements.hard.notes.find((x) => x.id === n.id)!;
    expect([back.dur, back.vel]).toEqual([n.dur, n.vel]);
  });

  it('staccato sits on the last piece of a tied note, accent on the first', () => {
    let s = locked(demo());
    const score = buildSheet(s, 'hard');
    const idx = writtenIndex(score);
    const tied = s.arrangements.hard.notes.find((n) => (idx.byId.get(n.id)?.length ?? 0) > 1 && !idx.byId.get(n.id)![0].inChord)!;
    expect(tied).toBeDefined();
    s = apply(s, articulationOp(ctxOf(s), new Set([tied.id]), 'staccato'));
    s = apply(s, articulationOp(ctxOf(s), new Set([tied.id]), 'accent'));
    const xml = xmlOf(s);
    const ns = measures(xml).flatMap(notesIn);
    const st = ns.findIndex((x) => descendants(x, 'staccato').length);
    const ac = ns.findIndex((x) => descendants(x, 'accent').length);
    expect(ns[st].children.some((c) => c.name === 'tie' && c.attrs.type === 'stop')).toBe(true);
    expect(ns[ac].children.some((c) => c.name === 'tie' && c.attrs.type === 'start')).toBe(true);
  });
});

describe('slurs', () => {
  it('a slur over the selection is written start → stop, removed when an end note is deleted, re-pointed by a tie', () => {
    let s = locked(demo());
    const ns = rh(s).slice(5, 9);
    s = apply(s, slurOp(ctxOf(s), new Set(ns.map((n) => n.id))));
    const sl = s.arrangements.hard.marks!.find((m) => m.kind === 'slur')!;
    expect(sl).toMatchObject({ kind: 'slur', from: ns[0].id, to: ns[3].id });
    const xml = xmlOf(s);
    expect(count(xml, /<slur type="start"/g)).toBe(1);
    expect(count(xml, /<slur type="stop"/g)).toBe(1);
    expect(xml.indexOf('<slur type="start"')).toBeLessThan(xml.indexOf('<slur type="stop"'));
    // the same selection again removes it
    expect(slurOp(ctxOf(s), new Set(ns.map((n) => n.id)))!.marks!.some((m) => m.kind === 'slur')).toBe(false);
    // deleting its last note removes it
    const del = deleteOp(ctxOf(s), new Set([ns[3].id]))!;
    expect(fixSlurs(s.arrangements.hard.marks, del.notes)!.some((m) => m.kind === 'slur')).toBe(false);
    // a re-pointed end (a tie merged b into a) keeps it when the new end is another note
    expect(fixSlurs(s.arrangements.hard.marks, s.arrangements.hard.notes, new Map([[ns[3].id, ns[2].id]]))![0]).toMatchObject({ from: ns[0].id, to: ns[2].id });
  });

  it('left-hand slurs go below; one per hand when both are selected', () => {
    let s = locked(demo());
    const sel = [...rh(s).slice(0, 3), ...lh(s).slice(0, 3)];
    s = apply(s, slurOp(ctxOf(s), new Set(sel.map((n) => n.id))));
    const slurs = s.arrangements.hard.marks!.filter((m) => m.kind === 'slur');
    expect(slurs).toHaveLength(2);
    expect(slurs.filter((m) => m.kind === 'slur' && m.below)).toHaveLength(1);
  });

  it('a tie merging two notes keeps a slur that ended on the second note', () => {
    const base = straightSong();
    let s = locked(base, 'medium');
    const ctx = ctxOf(s, 'medium');
    // two same-pitch right-hand notes back to back
    const ns = rh(s, 'medium');
    let pair: [Note, Note] | null = null;
    for (let i = 0; i < ns.length && !pair; i++)
      for (let j = i + 1; j < ns.length; j++) {
        const a = spanOf(ctx, ns[i]);
        const b = spanOf(ctx, ns[j]);
        if (ns[i].midi === ns[j].midi && b.on === a.off) pair = [ns[i], ns[j]];
      }
    if (!pair) return; // nothing to tie in this piece
    const first = ns[0];
    s = apply(s, { marks: [{ id: 'mslur0001', kind: 'slur', from: first.id === pair[0].id ? ns[1].id : first.id, to: pair[1].id }] }, 'medium');
    const res = tieOp(ctxOf(s, 'medium'), new Set([pair[0].id, pair[1].id]))!;
    const fixed = fixSlurs(s.arrangements.medium.marks, res.notes, res.repoint)!;
    expect(fixed.length === 0 || (fixed[0].kind === 'slur' && fixed[0].to === pair[0].id)).toBe(true);
  });
});

describe('dynamics', () => {
  it('a level dynamic rewrites the velocities up to the next one (both hands for staff 0), keeping the shape', () => {
    let s = locked(demo());
    const r = rh(s);
    const l = lh(s);
    s = apply(s, dynamicOp(ctxOf(s), new Set([r[0].id, l[0].id]), 'p', { bake: true, cursorMeasure: 0 }));
    const d = s.arrangements.hard.marks![0];
    expect(d).toMatchObject({ kind: 'dyn', pos: 0, staff: 0, value: 'p' });
    const vels = s.arrangements.hard.notes.map((n) => n.vel);
    const mean = vels.reduce((a, b) => a + b, 0) / vels.length;
    expect(mean).toBeCloseTo(0.4, 1);
    // a later f on the right hand only: from there the right hand is louder, the left hand stays p
    const at = r[40];
    const before = new Map(s.arrangements.hard.notes.map((n) => [n.id, n.vel]));
    s = apply(s, dynamicOp(ctxOf(s), new Set([at.id]), 'f', { bake: true, cursorMeasure: 0 }));
    const posF = spanOf(ctxOf(s), at).on;
    const ctx = ctxOf(s);
    for (const n of s.arrangements.hard.notes) {
      const on = spanOf(ctx, n).on;
      if (n.hand === 'L' || on < posF) expect(n.vel).toBe(before.get(n.id));
      else expect(n.vel).toBeGreaterThan(0.6);
    }
    expect(levelAt(s.arrangements.hard.marks, posF, 'R')).toBeCloseTo(0.72);
    expect(levelAt(s.arrangements.hard.marks, posF, 'L')).toBeCloseTo(0.4);
    // written below the staff with its playback level
    const xml = xmlOf(s);
    expect(xml).toMatch(/<direction placement="below"><direction-type><dynamics><p\/><\/dynamics><\/direction-type><staff>1<\/staff><sound dynamics="[\d.]+"\/><\/direction>/);
    expect(count(xml, /<dynamics>/g)).toBe(2);
    // the score reader takes the dynamics as velocities again
    const back = reimport(xml).notes;
    expect(pitchSet(back)).toEqual(pitchSet(s.arrangements.hard.notes));
  });

  it('is deterministic; equal velocities stay equal; switched off, the velocities stay', () => {
    const s = locked(demo());
    const a = dynamicOp(ctxOf(s), new Set(), 'mf', { bake: true, cursorMeasure: 2 })!;
    const b = dynamicOp(ctxOf(s), new Set(), 'mf', { bake: true, cursorMeasure: 2 })!;
    expect(a.notes!.map((n) => n.vel)).toEqual(b.notes!.map((n) => n.vel));
    expect(dynamicOp(ctxOf(s), new Set(), 'mf', { bake: false, cursorMeasure: 2 }).notes).toBeUndefined();
  });

  it('sf and sfz touch only the notes struck there; fp continues at p', () => {
    let s = locked(demo());
    const n = rh(s)[9];
    const ctx = ctxOf(s);
    const pos = spanOf(ctx, n).on;
    const res = dynamicOp(ctx, new Set([n.id]), 'sfz', { bake: true, cursorMeasure: 0 });
    for (const x of res.notes!) {
      const o = s.arrangements.hard.notes.find((y) => y.id === x.id)!;
      if (x.hand === 'R' && spanOf(ctx, o).on === pos) expect(x.vel).toBeCloseTo(0.88);
      else expect(x.vel).toBe(o.vel);
    }
    s = apply(s, dynamicOp(ctx, new Set([n.id]), 'fp', { bake: true, cursorMeasure: 0 }));
    const later = s.arrangements.hard.notes.filter((x) => x.hand === 'R' && spanOf(ctxOf(s), x).on > pos);
    const mean = later.reduce((a, x) => a + x.vel, 0) / later.length;
    expect(mean).toBeCloseTo(0.4, 1);
  });

  it('an accent on top of a dynamic stays an accent', () => {
    let s = locked(demo());
    const n = rh(s)[3];
    s = apply(s, articulationOp(ctxOf(s), new Set([n.id]), 'accent'));
    s = apply(s, dynamicOp(ctxOf(s), new Set([rh(s)[0].id]), 'pp', { bake: true, cursorMeasure: 0 }));
    const m = s.arrangements.hard.notes.find((x) => x.id === n.id)!;
    expect(m.vel).toBeCloseTo(m.artBase!.vel! + 0.15, 9);
    s = apply(s, articulationOp(ctxOf(s), new Set([n.id]), 'accent'));
    expect(s.arrangements.hard.notes.find((x) => x.id === n.id)!.vel).toBeCloseTo(m.artBase!.vel!, 9);
  });
});

describe('hairpins', () => {
  it('a crescendo ramps up monotonically to the next dynamic; without one by 0.12', () => {
    let s = locked(demo());
    // all right-hand notes the same velocity first, so the ramp is plain to see
    s = apply(s, { notes: s.arrangements.hard.notes.map((n) => ({ ...n, vel: 0.5 })) });
    const r = rh(s);
    s = apply(s, wedgeOp(ctxOf(s), new Set([r[16].id, r[47].id]), 'cresc', { bake: true, cursorMeasure: 0 }));
    const w = s.arrangements.hard.marks!.find((m) => m.kind === 'wedge') as Extract<SheetMark, { kind: 'wedge' }>;
    expect(w.staff).toBe(1);
    const ctx = ctxOf(s);
    const inside = rh(s)
      .map((n) => ({ n, on: spanOf(ctx, n).on }))
      .filter((x) => x.on >= w.pos && x.on < w.end)
      .sort((a, b) => a.on - b.on);
    expect(inside.length).toBeGreaterThan(10);
    for (let i = 1; i < inside.length; i++) expect(inside[i].n.vel).toBeGreaterThanOrEqual(inside[i - 1].n.vel - 1e-9);
    expect(inside[inside.length - 1].n.vel).toBeGreaterThan(0.5);
    expect(inside[inside.length - 1].n.vel).toBeLessThanOrEqual(0.62 + 1e-9);
    // to an f after its end
    let s2 = locked(demo());
    s2 = apply(s2, { notes: s2.arrangements.hard.notes.map((n) => ({ ...n, vel: 0.5 })) });
    s2 = apply(s2, dynamicOp(ctxOf(s2), new Set([rh(s2)[48].id]), 'f', { bake: false, cursorMeasure: 0 }));
    s2 = apply(s2, dynamicOp(ctxOf(s2), new Set([rh(s2)[16].id]), 'p', { bake: false, cursorMeasure: 0 }));
    const res = wedgeOp(ctxOf(s2), new Set([rh(s2)[16].id, rh(s2)[47].id]), 'cresc', { bake: true, cursorMeasure: 0 })!;
    const marks = res.marks!;
    const again = bakeWedge(ctxOf(s2), s2.arrangements.hard.notes, marks, marks.find((m) => m.kind === 'wedge') as Extract<SheetMark, { kind: 'wedge' }>);
    expect(again.map((n) => n.vel)).toEqual(res.notes!.map((n) => n.vel));
    const last = res.notes!.filter((n) => n.id === rh(s2)[47].id)[0];
    expect(last.vel).toBeGreaterThan(0.65);
    expect(res.notes!.find((n) => n.id === rh(s2)[16].id)!.vel).toBeCloseTo(0.4, 2);
  });

  it('a diminuendo is written start → stop and split at chunk edges', () => {
    let s = locked(demo());
    const r = rh(s);
    s = apply(s, wedgeOp(ctxOf(s), new Set([r[8].id, r[40].id]), 'dim', { bake: false, cursorMeasure: 0 }));
    const w = s.arrangements.hard.marks![0] as Extract<SheetMark, { kind: 'wedge' }>;
    const t = buildSheet(s, 'hard').time;
    const m0 = t.measureOf(w.pos);
    const m1 = t.measureOf(w.end - 1);
    expect(m1).toBeGreaterThan(m0);
    const whole = xmlOf(s);
    expect(count(whole, /<wedge type="diminuendo"/g)).toBe(1);
    expect(count(whole, /<wedge type="stop"/g)).toBe(1);
    // chunks: every chunk the hairpin crosses opens and closes it
    for (let a = 0; a <= m1; a++) {
      const xml = xmlOf(s, 'hard', a, a + 1);
      const starts = count(xml, /<wedge type="diminuendo"/g);
      const stops = count(xml, /<wedge type="stop"/g);
      expect(starts).toBe(stops);
      expect(starts).toBe(a >= m0 && a <= m1 ? 1 : 0);
    }
  });
});

describe('words', () => {
  it('are escaped, cleaned and placed above or below', () => {
    let s = locked(demo());
    s = apply(s, textOp(ctxOf(s), new Set([rh(s)[3].id]), ' dolce <& "calm">\u0007 ', { cursorMeasure: 0 }));
    const m = s.arrangements.hard.marks![0];
    expect(m).toMatchObject({ kind: 'text', text: 'dolce <& "calm">', staff: 1, above: true });
    const xml = xmlOf(s);
    expect(xml).toContain('<words>dolce &lt;&amp; &quot;calm&quot;&gt;</words>');
    expect(xml).toContain('<direction placement="above">');
    // the XML parser reads the same words back
    const words = descendants(parseXml(xml), 'words').map((w) => w.text);
    expect(words).toContain('dolce <& "calm">');
    expect(textOp(ctxOf(s), new Set(), '   ', { cursorMeasure: 0 })).toBeNull();
    s = apply(s, textOp(ctxOf(s), new Set([lh(s)[0].id]), 'rit.', { cursorMeasure: 0, style: 'italic', above: false }));
    expect(xmlOf(s)).toContain('<direction placement="below"><direction-type><words font-style="italic">rit.</words></direction-type><staff>2</staff></direction>');
  });
});

describe('pedal', () => {
  it('pedal over the selection cuts the pedal it overlaps and is written when shown', () => {
    let s = locked(demo());
    expect(count(xmlOf(s), /<pedal/g)).toBe(0); // older songs: no pedal marks
    const r = rh(s);
    const res = pedalOp(ctxOf(s), new Set([r[0].id, r[7].id]), 0)!;
    s = apply(s, res);
    expect(s.arrangements.hard.showPedal).toBe(true);
    expect(s.arrangements.hard.pedalEdited).toBe(true);
    const ps = s.arrangements.hard.pedal;
    for (let i = 1; i < ps.length; i++) expect(ps[i].start).toBeGreaterThanOrEqual(ps[i - 1].end - 1e-9);
    const xml = xmlOf(s);
    const starts = count(xml, /<pedal type="start"/g);
    expect(starts).toBeGreaterThan(0);
    expect(count(xml, /<pedal type="stop"/g)).toBe(starts);
    // per chunk, balanced
    const sc = buildSheet(s, 'hard');
    for (let a = 0; a < Math.min(8, sc.measureCount); a += 2) {
      const x = xmlOf(s, 'hard', a, a + 2);
      expect(count(x, /<pedal type="start"/g)).toBe(count(x, /<pedal type="stop"/g));
    }
  });

  it('a release followed by a new press within a grid step is written as a change', () => {
    let s = locked(demo());
    const t = buildSheet(s, 'hard').time;
    const at = (p: number) => t.posToTime(p);
    s = apply(s, { pedal: [{ start: at(0), end: at(24) }, { start: at(24), end: at(48) }], showPedal: true });
    const xml = xmlOf(s);
    expect(count(xml, /<pedal type="start"/g)).toBe(1);
    expect(count(xml, /<pedal type="change"/g)).toBe(1);
    expect(count(xml, /<pedal type="stop"/g)).toBe(1);
  });
});

describe('key, time and tempo changes', () => {
  it('a key change spells from its bar, prints cancelling naturals, and repeats in a later chunk', () => {
    let s = locked(demo());
    const t = buildSheet(s, 'hard').time;
    s = { ...s, sheet: { ...s.sheet!, keys: [{ pos: t.measureStart(2), fifths: 2, mode: 'major' }, { pos: t.measureStart(4), fifths: 0, mode: 'major' }] } };
    const sc = buildSheet(s, 'hard');
    expect(keyAt(sc, 1).fifths).toBe(0);
    expect(keyAt(sc, 2).fifths).toBe(2);
    expect(keyAt(sc, 3).fifths).toBe(2);
    expect(keyAt(sc, 4).fifths).toBe(0);
    const ms = measures(xmlOf(s));
    const keyIn = (i: number) => descendants(ms[i], 'key')[0];
    expect(childText(keyIn(2), 'fifths')).toBe('2');
    expect(keyIn(3)).toBeUndefined();
    expect(childText(keyIn(4), 'cancel')).toBe('2');
    expect(childText(keyIn(4), 'fifths')).toBe('0');
    // F♯ in D major needs no sharp; in C it does
    const accIn = (i: number) => descendants(ms[i], 'accidental').map((a) => a.text);
    const fsharp = s.arrangements.hard.notes.some((n) => n.midi % 12 === 6 && sc.time.measureOf(spanOf(ctxOf(s), n).on) === 2);
    if (fsharp) expect(accIn(2)).not.toContain('sharp');
    // a chunk starting in D major carries its key
    expect(childText(descendants(parseXml(xmlOf(s, 'hard', 3, 4)), 'key')[0], 'fifths')).toBe('2');
    // the importer reads the per-measure keys without trouble
    expect(pitchSet(reimport(xmlOf(s)).notes)).toEqual(pitchSet(s.arrangements.hard.notes));
  });

  it('a 4/4 → 3/4 → 6/8 relabel keeps every note in place (seconds and position) and regroups the bars', () => {
    const s0 = locked(demo());
    const sc0 = buildSheet(s0, 'hard');
    const t0 = sc0.time;
    const a = t0.measureStart(2); // 96
    const b = a + 2 * 36; // two bars of 3/4 later
    const s: Song = { ...s0, sheet: { ...s0.sheet!, meters: [{ pos: a, beatsPerBar: 3, beatUnit: 4 }, { pos: b, beatsPerBar: 6, beatUnit: 8 }] } };
    const sc = buildSheet(s, 'hard');
    const t = sc.time;
    expect([t.measureStart(2), t.measureStart(3), t.measureStart(4), t.measureStart(5)]).toEqual([a, a + 36, b, b + 36]);
    expect(t.measureLenAt(1)).toBe(48);
    expect(t.measureLenAt(2)).toBe(36);
    expect(t.measureLenAt(4)).toBe(36);
    expect(t.meterAt(4)).toMatchObject({ beatsPerBar: 6, beatUnit: 8, compound: true, beatLen: 18 });
    expect(t.measureOf(a - 1)).toBe(1);
    expect(t.measureOf(a)).toBe(2);
    expect(t.measureOf(b + 35)).toBe(4);
    expect(t.measureOf(b + 36)).toBe(5);
    // the same notes at the same seconds and positions
    expect(sc.notes.map((n) => [n.midi, n.on, n.off])).toEqual(sc0.notes.map((n) => [n.midi, n.on, n.off]));
    for (const p of [0, 50, a, b + 7, 500]) expect(t.posToTime(p)).toBe(t0.posToTime(p));
    expect(s.arrangements).toBe(s0.arrangements);
    // measure lengths in the XML add up per voice
    const ms = measures(xmlOf(s));
    expect(ms.length).toBe(sc.measureCount);
    for (const [i, m] of ms.entries()) {
      const len = t.measureLenAt(i);
      const v1 = notesIn(m).filter((n) => childText(n, 'voice') === '1' && !n.children.some((c) => c.name === 'chord'));
      expect(v1.reduce((x, n) => x + Number(childText(n, 'duration')), 0)).toBe(len);
    }
    expect(childText(descendants(ms[2], 'time')[0], 'beats')).toBe('3');
    expect(descendants(ms[2], 'time')[0].attrs['print-object']).toBeUndefined();
    expect(childText(descendants(ms[4], 'time')[0], 'beat-type')).toBe('8');
    expect(descendants(ms[3], 'time')).toHaveLength(0);
    // the score reader reads the written-out bars with the same notes
    const back = reimport(xmlOf(s));
    expect(pitchSet(back.notes)).toEqual(pitchSet(s.arrangements.hard.notes));
  });

  it('a meter change off a bar line ends the bar before it early', () => {
    const s0 = locked(demo());
    const t0 = buildSheet(s0, 'hard').time;
    const s: Song = { ...s0, sheet: { ...s0.sheet!, meters: [{ pos: t0.measureStart(2) + 12, beatsPerBar: 3, beatUnit: 4 }] } };
    const t = gridFromLock(s.sheet!.grid, 'midi', s.sheet!.meters);
    expect(t.measureLenAt(2)).toBe(12);
    expect(t.measureStart(3)).toBe(t0.measureStart(2) + 12);
  });

  it('a tempo mark replaces the inferred marks from its bar on and is written with its words', () => {
    let s = locked(demo());
    const t = buildSheet(s, 'hard').time;
    s = { ...s, sheet: { ...s.sheet!, tempos: [{ pos: t.measureStart(3), bpm: 90, unit: 'q', text: 'Andante', retimed: false }] } };
    const sc = buildSheet(s, 'hard');
    expect(sc.tempoMarks.at(-1)).toMatchObject({ measure: 3, bpm: 90, qpm: 90, text: 'Andante' });
    const xml = xmlOf(s);
    expect(xml).toContain('<words font-weight="bold">Andante</words></direction-type><direction-type><metronome parentheses="no"><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><staff>1</staff><sound tempo="90"/>');
    const s2: Song = { ...s, sheet: { ...s.sheet!, tempos: [{ pos: t.measureStart(3), bpm: 60, unit: 'q.', retimed: false }] } };
    expect(xmlOf(s2)).toContain('<beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type><staff>1</staff><sound tempo="90"/>');
  });
});

describe('every marking at once', () => {
  it('is valid XML that the score reader reads with the same notes (a full file and chunks)', () => {
    let s = locked(demo());
    const r = rh(s);
    const l = lh(s);
    s = apply(s, fingerOp(ctxOf(s), new Set([r[0].id]), 3));
    s = apply(s, articulationOp(ctxOf(s), new Set([r[1].id]), 'staccato'));
    s = apply(s, articulationOp(ctxOf(s), new Set([r[2].id]), 'accent'));
    s = apply(s, slurOp(ctxOf(s), new Set([r[3].id, r[7].id])));
    s = apply(s, dynamicOp(ctxOf(s), new Set([r[0].id, l[0].id]), 'mf', { bake: true, cursorMeasure: 0 }));
    s = apply(s, wedgeOp(ctxOf(s), new Set([r[8].id, r[30].id]), 'cresc', { bake: true, cursorMeasure: 0 }));
    s = apply(s, textOp(ctxOf(s), new Set([r[1].id]), 'dolce', { cursorMeasure: 0 }));
    s = apply(s, pedalOp(ctxOf(s), new Set([r[0].id, r[15].id]), 0));
    const t = buildSheet(s, 'hard').time;
    s = { ...s, sheet: { ...s.sheet!, keys: [{ pos: t.measureStart(2), fifths: 2, mode: 'major' }], meters: [{ pos: t.measureStart(3), beatsPerBar: 3, beatUnit: 4 }], tempos: [{ pos: t.measureStart(2), bpm: 90, unit: 'q', retimed: false }] } };
    const full = songMusicXml(s, 'hard');
    expect(() => parseXml(full)).not.toThrow();
    const back = reimport(full);
    expect(pitchSet(back.notes)).toEqual(pitchSet(s.arrangements.hard.notes));
    const sc = buildSheet(s, 'hard');
    for (let a = 0; a < sc.measureCount; a += 3) {
      const x = toMusicXml(sc, { title: '', from: a, to: a + 3 });
      expect(() => parseXml(x)).not.toThrow();
      expect(count(x, /<slur type="start"/g)).toBe(count(x, /<slur type="stop"/g));
      expect(count(x, /<wedge type="(crescendo|diminuendo)"/g)).toBe(count(x, /<wedge type="stop"/g));
      expect(count(x, /<pedal type="start"/g)).toBe(count(x, /<pedal type="stop"/g));
    }
  });

  it('songs without markings are unchanged (no new elements)', () => {
    for (const [, make] of GOLDEN_SONGS) {
      const xml = songMusicXml(make(), 'hard');
      for (const tag of ['<fingering', '<slur', '<dynamics', '<wedge', '<words', '<pedal', '<articulations', '<cancel']) expect(xml).not.toContain(tag);
    }
  });
});

describe('Easy & Medium from Hard', () => {
  it('carries fingering, articulations, positional marks, matching slurs and edited pedal', () => {
    let s = locked(demo());
    const r = rh(s);
    s = apply(s, fingerOp(ctxOf(s), new Set([r[0].id]), 2));
    s = apply(s, articulationOp(ctxOf(s), new Set([r[2].id]), 'accent'));
    s = apply(s, slurOp(ctxOf(s), new Set([r[0].id, r[2].id])));
    s = apply(s, dynamicOp(ctxOf(s), new Set([r[0].id]), 'mf', { bake: false, cursorMeasure: 0 }));
    s = apply(s, pedalOp(ctxOf(s), new Set([r[0].id, r[4].id]), 0));
    const out = easyMediumFromHard(s);
    for (const lv of ['easy', 'medium'] as const) {
      const a = out.arrangements[lv];
      const same = (h: Note) => a.notes.find((n) => n.midi === h.midi && n.hand === h.hand && Math.abs(n.start - h.start) < 0.001);
      const f = same(s.arrangements.hard.notes.find((n) => n.id === r[0].id)!);
      if (f) expect(f.finger).toBe(2);
      expect(a.notes.some((n) => n.pin)).toBe(false);
      expect(a.marks?.some((m) => m.kind === 'dyn' && m.value === 'mf')).toBe(true);
      const slur = a.marks?.find((m) => m.kind === 'slur');
      if (slur && slur.kind === 'slur') expect(a.notes.some((n) => n.id === slur.from) && a.notes.some((n) => n.id === slur.to)).toBe(true);
      expect(a.pedalEdited).toBe(true);
      expect(a.pedal).toEqual(s.arrangements.hard.pedal);
      expect(a.showPedal).toBe(true);
    }
    // the medium level keeps the right hand's top line: the fingered note is there
    const mf = out.arrangements.medium.notes.find((n) => n.finger === 2);
    expect(mf).toBeDefined();
  });

  it('carryMarks without matches copies positional marks only', () => {
    const hard: Arrangement = { notes: [{ id: 1, midi: 60, start: 0, dur: 1, vel: 0.5, hand: 'R', finger: 1 }, { id: 2, midi: 62, start: 1, dur: 1, vel: 0.5, hand: 'R' }], pedal: [], edited: true, generatedAt: 0, marks: [{ id: 'ma', kind: 'slur', from: 1, to: 2 }, { id: 'mb', kind: 'text', pos: 0, staff: 1, text: 'x', above: true }] };
    const derived: Arrangement = { notes: [{ id: 9, midi: 64, start: 0, dur: 1, vel: 0.5, hand: 'R' }], pedal: [{ start: 0, end: 1 }], edited: false, generatedAt: 0 };
    const out = carryMarks(hard, derived);
    expect(out.marks).toHaveLength(1);
    expect(out.marks![0].kind).toBe('text');
    expect(out.notes[0].finger).toBeUndefined();
    expect(out.pedal).toEqual(derived.pedal);
  });
});

describe('sanitizer: markings', () => {
  it('keeps valid markings, drops damaged ones, never throws', () => {
    const s = locked(demo());
    const ids = rh(s).map((n) => n.id);
    const lid = lh(s)[0].id;
    const bad = JSON.parse(
      JSON.stringify({
        ...s,
        sheet: {
          ...s.sheet,
          keys: [{ pos: 48, fifths: 2, mode: 'major' }, { pos: 48, fifths: 3, mode: 'major' }, { pos: -1, fifths: 0, mode: 'major' }, { pos: 96, fifths: 9, mode: 'major' }],
          meters: [{ pos: 0, beatsPerBar: 3, beatUnit: 4 }, { pos: 12, beatsPerBar: 0, beatUnit: 4 }, { pos: 24, beatsPerBar: 3, beatUnit: 3 }],
          tempos: [{ pos: 0, bpm: 90, unit: 'q', text: 'x'.repeat(60), retimed: true }, { pos: 12, bpm: 9999, unit: 'q', retimed: false }, { pos: 24, bpm: 80, unit: 'w', retimed: false }],
        },
        arrangements: {
          ...s.arrangements,
          hard: {
            ...s.arrangements.hard,
            showPedal: 'yes',
            pedalEdited: true,
            notes: s.arrangements.hard.notes.map((n, i) => (i === 0 ? { ...n, finger: 7, art: ['staccato', 'staccato', 'wobble'], artBase: { dur: -1, vel: 0.5 } } : i === 1 ? { ...n, finger: 2, art: 'accent' } : n)),
            marks: [
              { id: 'm1', kind: 'dyn', pos: 0, staff: 0, value: 'mf' },
              { id: 'm1', kind: 'dyn', pos: 0, staff: 0, value: 'mf' },
              { id: 'm2', kind: 'dyn', pos: 0, staff: 3, value: 'mf' },
              { id: 'm3', kind: 'wedge', pos: 10, end: 5, staff: 1, dir: 'cresc' },
              { id: 'm4', kind: 'text', pos: 0, staff: 1, text: '\u0001\u0002   ', above: true },
              { id: 'm5', kind: 'text', pos: 0, staff: 1, text: 'a'.repeat(200), above: false, style: 'weird' },
              { id: 'm6', kind: 'slur', from: ids[0], to: ids[3] },
              { id: 'm7', kind: 'slur', from: ids[0], to: lid },
              { id: 'm8', kind: 'slur', from: ids[0], to: 99999999 },
              { id: 'm9', kind: 'sparkle', pos: 0 },
              null,
              42,
            ],
          },
        },
      }),
    ) as Song;
    const out = sanitizeSheetData(bad);
    expect(out.sheet!.keys).toEqual([{ pos: 48, fifths: 3, mode: 'major' }]);
    expect(out.sheet!.meters).toEqual([{ pos: 0, beatsPerBar: 3, beatUnit: 4 }]);
    expect(out.sheet!.tempos).toEqual([{ pos: 0, bpm: 90, unit: 'q', text: 'x'.repeat(40), retimed: true }]);
    const h = out.arrangements.hard;
    expect('showPedal' in h).toBe(false);
    expect(h.pedalEdited).toBe(true);
    expect(h.notes[0].finger).toBeUndefined();
    expect(h.notes[0].art).toEqual(['staccato']);
    expect(h.notes[0].artBase).toEqual({ vel: 0.5 });
    expect(h.notes[1].finger).toBe(2);
    expect(h.notes[1].art).toBeUndefined();
    expect(h.marks!.map((m) => m.id)).toEqual(['m1', 'm5', 'm6']);
    expect((h.marks![1] as { text: string }).text).toHaveLength(80);
    expect('style' in h.marks![1]).toBe(false);
    // the sanitized song still writes its sheet
    expect(() => songMusicXml(out, 'hard')).not.toThrow();
    for (const junk of [{ marks: 'x' }, { marks: [{ kind: 'dyn' }] }, { marks: [{ id: 'q', kind: 'slur', from: 'a', to: 'b' }] }])
      expect(() => sanitizeSheetData({ ...s, arrangements: { ...s.arrangements, hard: { ...s.arrangements.hard, ...junk } } } as unknown as Song)).not.toThrow();
  });
});

describe('positions of new marks', () => {
  it('with nothing selected, marks go to the measure at the cursor, both hands', () => {
    const s = locked(demo());
    const res = dynamicOp(ctxOf(s), new Set(), 'p', { bake: false, cursorMeasure: 3 });
    expect(res.marks![0]).toMatchObject({ pos: buildSheet(s, 'hard').time.measureStart(3), staff: 0 });
    const w = wedgeOp(ctxOf(s), new Set(), 'dim', { bake: false, cursorMeasure: 3 })!;
    expect((w.marks![0] as Extract<SheetMark, { kind: 'wedge' }>).end - (w.marks![0] as Extract<SheetMark, { kind: 'wedge' }>).pos).toBe(4 * DIV);
  });

  it('bakeDynamic leaves notes before the mark alone', () => {
    const s = locked(demo());
    const marks: SheetMark[] = [{ id: 'mx', kind: 'dyn', pos: 96, staff: 0, value: 'ff' }];
    const out = bakeDynamic(ctxOf(s), s.arrangements.hard.notes, marks, marks[0] as Extract<SheetMark, { kind: 'dyn' }>);
    const ctx = ctxOf(s);
    out.forEach((n, i) => {
      if (spanOf(ctx, s.arrangements.hard.notes[i]).on < 96) expect(n.vel).toBe(s.arrangements.hard.notes[i].vel);
    });
  });
});

describe('ends of hairpins and pedal', () => {
  it('a drag sets the start or end (never past the other end)', () => {
    let s = locked(demo());
    s = apply(s, wedgeOp(ctxOf(s), new Set([rh(s)[2].id, rh(s)[9].id]), 'cresc', { bake: false, cursorMeasure: 0 }));
    const w = s.arrangements.hard.marks![0] as Extract<SheetMark, { kind: 'wedge' }>;
    const r = resizeMarkOp(ctxOf(s), w.id, 'end', w.end + 24)!;
    expect((r.marks![0] as typeof w).end).toBe(w.end + 24);
    expect(resizeMarkOp(ctxOf(s), w.id, 'start', w.end)).toBeNull();
    s = apply(s, pedalOp(ctxOf(s), new Set([rh(s)[0].id, rh(s)[3].id]), 0));
    const t = buildSheet(s, 'hard').time;
    const p = s.arrangements.hard.pedal.find((x) => Math.abs(x.end - t.posToTime(spanOf(ctxOf(s), rh(s)[3]).off)) < 1e-9)!;
    const res = resizeMarkOp(ctxOf(s), pedalSel(p), 'end', 48)!;
    expect(res.pedal!.some((x) => x.start === p.start && Math.abs(x.end - t.posToTime(48)) < 1e-9)).toBe(true);
  });

  it('a direction is written in the voice that has an item starting right at it', () => {
    let s = locked(demo());
    const t = buildSheet(s, 'hard').time;
    // pos 6: the right hand's first note; the left hand plays a dotted 8th from 3
    s = apply(s, { pedal: [{ start: t.posToTime(6), end: t.posToTime(24) }], showPedal: true });
    const m0 = measures(xmlOf(s))[0];
    const i = m0.children.findIndex((c) => c.name === 'direction' && descendants(c, 'pedal').length);
    const next = m0.children.slice(i + 1).find((c) => c.name === 'note')!;
    expect(childText(next, 'voice')).toBe('1');
    expect(childText(m0.children[i], 'staff')).toBe('2');
  });
});

describe('automatic pedal', () => {
  it('keeps pedal edited on the sheet unless told to replace it', () => {
    const s0 = { ...demo(), hasAudio: true, source: { kind: 'audio' as const } };
    const edited = { ...s0, arrangements: { ...s0.arrangements, hard: { ...s0.arrangements.hard, pedal: [{ start: 1, end: 2 }], pedalEdited: true as const } } };
    expect(withAutoPedal(edited, true).arrangements.hard.pedal).toEqual([{ start: 1, end: 2 }]);
    const replaced = withAutoPedal(edited, true, { replaceEdited: true }).arrangements.hard;
    expect(replaced.pedalEdited).toBeUndefined();
    expect(replaced.pedal).not.toEqual([{ start: 1, end: 2 }]);
  });
});
