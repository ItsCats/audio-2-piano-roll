/**
 * Sheet editing, review fixes: one grid lock for every level (and moving its start when a note is
 * placed before it), a 6/8 lock that survives the sanitizer, lengths the sheet can write after a
 * triplet, chord tones of different pinned lengths, MIDI time signatures only on bar lines, undo of
 * the automatic pedal switch, the score cache, and the Alt+arrow keys.
 */
import { describe, expect, it } from 'vitest';
import type { Difficulty, Note, Song } from '../../src/lib/music/types';
import { regularBeats } from '../../src/lib/music/beats';
import { sortNotes } from '../../src/lib/music/cleanup';
import { buildSheet, toMusicXml } from '../../src/lib/sheet';
import { ensureSheet, rebaseSheet } from '../../src/lib/sheet/lock';
import { writtenIndex, writtenSpan } from '../../src/lib/sheet/written';
import { sanitizeSheetData } from '../../src/lib/sheet/sanitize';
import { sheetMidiMeta } from '../../src/lib/sheet/midiMeta';
import { exportMidi } from '../../src/lib/music/midi';
import { addOp, lengthName, lengthOp, pitchOp, type SheetCtx, type SheetEditResult } from '../../src/lib/sheet/edit';
import { sheetKeyAction } from '../../src/state/sheetKeys';
import { GOLDEN_SONGS, straightSong } from './sheetSongs';
import { Midi } from '@tonejs/midi';
import { importMusicXml } from '../../src/lib/score';
import { songFromScore } from '../../src/lib/songs';

const q = 0.5;
const mk = (id: number, midi: number, start: number, dur: number, hand: 'L' | 'R'): Note => ({ id, midi, start, dur, vel: 0.7, hand });
const arrOf = (notes: Note[]) => ({ notes, pedal: [], edited: false, generatedAt: 0 });

/** A 4/4 song at 120 BPM (a quarter = 0.5 s) with these notes on every level (or per level). */
function plain(notes: Note[], per: Partial<Record<Difficulty, Note[]>> = {}, source: 'midi' | 'estimated' = 'midi', downbeatIndex = 0): Song {
  const base = straightSong();
  return {
    ...base,
    duration: 16,
    base: notes,
    key: { tonic: 0, mode: 'major', name: 'C major', confidence: 1 },
    tempo: { bpm: 120, beats: regularBeats(120, 0, 20), beatsPerBar: 4, downbeatIndex, confidence: 1, source },
    arrangements: { easy: arrOf(per.easy ?? notes), medium: arrOf(per.medium ?? notes), hard: arrOf(per.hard ?? notes) },
  };
}
const ctxOf = (song: Song, level: Difficulty = 'medium'): SheetCtx => ({ song, level, score: buildSheet(song, level) });
function apply(song: Song, level: Difficulty, res: SheetEditResult): Song {
  return { ...song, sheet: ensureSheet(song, level), arrangements: { ...song.arrangements, [level]: { ...song.arrangements[level], notes: sortNotes(res.notes), edited: true } }, ...(res.duration ? { duration: res.duration } : {}) };
}
const measureXml = (x: string, n: number) => x.slice(x.indexOf(`<measure number="${n}"`), x.indexOf(`<measure number="${n + 1}"`));
/** Every <note>'s <type> agrees with its <duration> (12 divisions a quarter). */
function typesMatch(xml: string): string[] {
  const TY: Record<string, number> = { whole: 48, half: 24, quarter: 12, eighth: 6, '16th': 3, '32nd': 1.5 };
  const bad: string[] = [];
  for (const m of xml.matchAll(/<note>(.*?)<\/note>/gs)) {
    const body = m[1];
    const d = Number(/<duration>(\d+)<\/duration>/.exec(body)?.[1]);
    const ty = /<type>(\w+)<\/type>/.exec(body)?.[1];
    if (!ty || /<grace/.test(body) || /measure="yes"/.test(body)) continue;
    let e = TY[ty] * ((body.match(/<dot\/>/g) ?? []).length === 1 ? 1.5 : (body.match(/<dot\/>/g) ?? []).length === 2 ? 1.75 : 1);
    if (/<time-modification>/.test(body)) e *= 2 / 3;
    if (Math.abs(e - d) > 0.01) bad.push(`${ty} vs ${d}`);
  }
  return bad;
}

describe('one grid lock for every level', () => {
  it('a level without the intro locks where the earliest level starts: the other levels keep their bars', () => {
    const s0 = straightSong();
    const easyNotes = s0.arrangements.easy.notes.filter((n) => n.start >= 4 * 2.4 - 0.01); // Easy leaves out the 4-bar intro
    const song: Song = { ...s0, arrangements: { ...s0.arrangements, easy: { ...s0.arrangements.easy, notes: easyNotes } } };
    const before = buildSheet(song, 'hard');
    const locked: Song = { ...song, sheet: ensureSheet(song, 'easy') };
    const after = buildSheet(locked, 'hard');
    expect(after.measureCount).toBe(before.measureCount);
    for (const n of song.arrangements.hard.notes) expect(writtenSpan(after, n.id)).toEqual(writtenSpan(before, n.id));
    expect(toMusicXml(after, { title: '' })).toBe(toMusicXml(before, { title: '' }));
  });

  it('a pickup only Hard has is kept when Easy is edited first', () => {
    const body: Note[] = [];
    let id = 1;
    for (let b = 0; b < 16; b++) {
      body.push(mk(id++, 64 + (b % 5), 1 + b * q, 0.45, 'R'));
      if (b % 4 === 0) body.push(mk(id++, 48, 1 + b * q, 1.9, 'L'));
    }
    const hard = [mk(900, 62, 0.5, 0.45, 'R'), mk(901, 60, 0.25, 0.2, 'R'), ...body];
    const song = plain(hard, { easy: body, medium: body, hard }, 'estimated', 2);
    const before = buildSheet(song, 'hard');
    expect(before.time.pickup).toBeGreaterThan(0);
    const after = buildSheet({ ...song, sheet: ensureSheet(song, 'easy') }, 'hard');
    expect(after.time.pickup).toBe(before.time.pickup);
    for (const nid of [900, 901, 1]) expect(writtenSpan(after, nid)).toEqual(writtenSpan(before, nid));
  });

  it('a note placed before the locked start moves the start back; bar lines, pins and marks stay in place', () => {
    const body: Note[] = [];
    for (let b = 0; b < 16; b++) body.push(mk(b + 1, 64 + (b % 5), 4 + b * q, 0.45, 'R'));
    let song = plain(body);
    // a sheet edit pins note 3 and a dynamic is placed at its onset
    song = apply(song, 'hard', pitchOp(ctxOf(song, 'hard'), new Set([3]), 'step', 1)!);
    expect(song.sheet!.grid.originQ).toBe(8);
    const pin3 = song.arrangements.hard.notes.find((n) => n.id === 3)!.pin!;
    song = {
      ...song,
      sheet: { ...song.sheet!, keys: [{ pos: 48, fifths: 2, mode: 'major' }], bars: 6 },
      arrangements: { ...song.arrangements, hard: { ...song.arrangements.hard, marks: [{ id: 'mx', kind: 'dyn', pos: pin3.on, staff: 1, value: 'f' }] } },
    };
    const t0 = buildSheet(song, 'hard').time;
    const keyTime = t0.posToTime(48);
    // the piano roll adds two notes in the intro (2 s and 2.5 s: one bar before the first written bar)
    const withIntro: Song = { ...song, arrangements: { ...song.arrangements, hard: { ...song.arrangements.hard, notes: sortNotes([mk(500, 72, 2, 0.45, 'R'), mk(501, 74, 2.5, 0.45, 'R'), ...song.arrangements.hard.notes]) } } };
    const r = rebaseSheet(withIntro)!;
    expect(r).not.toBeNull();
    const moved: Song = { ...withIntro, ...r };
    const s = buildSheet(moved, 'hard');
    const by = r.sheet.grid.originQ === 4 ? 48 : NaN;
    expect(by).toBe(48);
    expect(writtenSpan(s, 500)!.on).toBe(0);
    expect(writtenSpan(s, 501)!.on).toBe(12);
    expect(writtenSpan(s, 1)!.on).toBe(48);
    // the same seconds for every bar line and for the stored positions
    for (let m = 0; m < 4; m++) expect(s.time.posToTime(s.time.measureStart(m + 1))).toBeCloseTo(t0.posToTime(t0.measureStart(m)), 9);
    const n3 = moved.arrangements.hard.notes.find((n) => n.id === 3)!;
    expect(n3.pin!.on).toBe(pin3.on + 48);
    expect(writtenSpan(s, 3)).toMatchObject({ on: pin3.on + 48, off: pin3.off + 48 });
    expect(moved.arrangements.hard.marks![0]).toMatchObject({ pos: pin3.on + 48 });
    expect(s.time.posToTime(moved.sheet!.keys![0].pos)).toBeCloseTo(keyTime, 9);
    expect(moved.sheet!.bars).toBe(7);
    // nothing to move: null
    expect(rebaseSheet(moved)).toBeNull();
    expect(rebaseSheet(song)).toBeNull();
  });

});

describe('sanitizer and fast compound meters', () => {
  it('a 6/8 score at a dotted quarter of 144 (432 8ths a minute) keeps its sheet data after a reload', () => {
    const N = (m: number) => `<note><pitch><step>${'CCDDEFFGGAAB'[m % 12]}</step>${[1, 3, 6, 8, 10].includes(m % 12) ? '<alter>1</alter>' : ''}<octave>${Math.floor(m / 12) - 1}</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type></note>`;
    const ms: string[] = [];
    for (let i = 0; i < 8; i++)
      ms.push(`<measure number="${i + 1}">${i === 0 ? '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>6</beats><beat-type>8</beat-type></time></attributes><direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>144</per-minute></metronome></direction-type><sound tempo="216"/></direction>' : ''}${[72, 74, 76, 77, 79, 77].map(N).join('')}</measure>`);
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${ms.join('')}</part></score-partwise>`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const song = songFromScore(importMusicXml(xml), { kind: 'score', fileName: 'jig.musicxml' } as any);
    const level: Difficulty = 'hard';
    const n = song.arrangements[level].notes[1];
    const edited = apply(song, level, pitchOp(ctxOf(song, level), new Set([n.id]), 'step', 1)!);
    expect(edited.sheet!.grid.bpm).toBeGreaterThan(400);
    const back = sanitizeSheetData(structuredClone(edited));
    expect(back.sheet).toBeTruthy();
    expect(back.arrangements[level].notes.find((x) => x.id === n.id)!.pin).toBeTruthy();
  });
});

describe('lengths the sheet can write', () => {
  it('Longer on a triplet 8th that ends in a straight beat ends on that beat’s 16th grid', () => {
    let song = plain([mk(1, 72, 0, q, 'R'), mk(2, 74, q, q, 'R'), mk(3, 76, 2 * q, 2 * q, 'R'), mk(9, 48, 0, 4 * q, 'L')]);
    song = apply(song, 'medium', lengthOp(ctxOf(song), new Set([1]), { triplet: true })!);
    expect(writtenSpan(buildSheet(song, 'medium'), 1)).toMatchObject({ on: 0, off: 8 });
    const r2 = addOp(ctxOf(song), { pos: 8, midi: 77, staff: 1, len: 4 })!;
    const id = r2.select![0];
    song = apply(song, 'medium', r2);
    song = apply(song, 'medium', lengthOp(ctxOf(song), new Set([id]), { step: 1 })!);
    const n = song.arrangements.medium.notes.find((x) => x.id === id)!;
    expect(n.pin).toMatchObject({ on: 8, off: 15 });
    const s = buildSheet(song, 'medium');
    expect(writtenSpan(s, id)).toMatchObject({ on: 8, off: 15 });
    expect(typesMatch(toMusicXml(s, { title: '' }))).toEqual([]);
  });

  it('an added note inside a triplet quarter starts on the triplet grid', () => {
    let song = plain([mk(1, 72, 0, q, 'R'), mk(2, 74, q, q, 'R'), mk(9, 48, 0, 4 * q, 'L')]);
    song = apply(song, 'hard', lengthOp(ctxOf(song, 'hard'), new Set([1]), { triplet: true })!);
    const r = addOp(ctxOf(song, 'hard'), { pos: 9, midi: 79, staff: 1, len: 3 })!;
    song = apply(song, 'hard', r);
    const w = writtenSpan(buildSheet(song, 'hard'), r.select![0])!;
    expect(w.on % 4).toBe(0);
    expect(typesMatch(toMusicXml(buildSheet(song, 'hard'), { title: '' }))).toEqual([]);
  });
});

describe('chord tones of different pinned lengths', () => {
  for (const level of ['medium', 'hard'] as const)
    it(`under a moving 8th melody each keeps its own length (${level}), the longer one tied on`, () => {
      const mel: Note[] = [];
      for (let i = 0; i < 8; i++) mel.push(mk(10 + i, 76 + (i % 3), (i * q) / 2, q / 2, 'R'));
      let song = plain([...mel, mk(9, 48, 0, 4 * q, 'L')]);
      let r = addOp(ctxOf(song, level), { pos: 0, midi: 64, staff: 1, len: 12 })!;
      const a = r.select![0];
      song = apply(song, level, r);
      r = addOp(ctxOf(song, level), { pos: 0, midi: 67, staff: 1, len: 24 })!;
      const b = r.select![0];
      song = apply(song, level, r);
      const s = buildSheet(song, level);
      expect(writtenSpan(s, a)).toMatchObject({ on: 0, off: 12 });
      expect(writtenSpan(s, b)).toMatchObject({ on: 0, off: 24 });
      const x = toMusicXml(s, { title: '' });
      const m1 = measureXml(x, 1);
      // G4: a quarter tied to a quarter; E4: one quarter, not tied
      expect(m1.match(/<step>G<\/step><octave>4<\/octave><\/pitch><duration>12<\/duration><tie type="start"\/>/g)).toHaveLength(1);
      expect(m1.match(/<step>G<\/step><octave>4<\/octave><\/pitch><duration>12<\/duration><tie type="stop"\/>/g)).toHaveLength(1);
      expect(m1).toMatch(/<step>E<\/step><octave>4<\/octave><\/pitch><duration>12<\/duration><voice>/);
      expect(typesMatch(x)).toEqual([]);
      // every written piece is found by its ids (hit-testing and the status line)
      const idx = writtenIndex(s);
      expect(idx.byId.get(b)!.length).toBe(2);
    });

  it('a note starting while both voices hold pinned notes joins one of them, the held note tied over', () => {
    const notes = [mk(1, 71, 0, 2 * q, 'R'), mk(2, 72, q / 2, q, 'R'), mk(3, 74, q, q / 2, 'R'), mk(9, 48, 0, 4 * q, 'L')];
    let song = plain(notes);
    // pin 1 (0-24) and 2 (6-18): both voices are held when 3 (an unpinned note at 12) starts
    song = apply(song, 'hard', pitchOp(ctxOf(song, 'hard'), new Set([1, 2]), 'step', 1)!);
    song = apply(song, 'hard', pitchOp(ctxOf(song, 'hard'), new Set([1, 2]), 'step', -1)!);
    const s = buildSheet(song, 'hard');
    for (const n of song.arrangements.hard.notes.filter((x) => x.pin)) expect(writtenSpan(s, n.id)).toMatchObject({ on: n.pin!.on, off: n.pin!.off });
    expect(writtenSpan(s, 3)!.on).toBe(12);
    expect(typesMatch(toMusicXml(s, { title: '' }))).toEqual([]);
  });

  it('songs without pins are written exactly as before (the golden files cover the rest)', () => {
    for (const [, make] of GOLDEN_SONGS) for (const lv of ['easy', 'medium', 'hard'] as const) for (const sv of buildSheet(make(), lv).staves) for (const v of sv.voices) for (const c of v) expect(c.ends ?? c.tieIn ?? c.tieOut).toBeUndefined();
  });
});

describe('MIDI time signatures only on bar lines', () => {
  const sigs = (bytes: Uint8Array) => new Midi(bytes).header.timeSignatures.map((t) => ({ ticks: t.ticks, sig: t.timeSignature.join('/') }));
  it('written where the file’s bars match the sheet; left out where they don’t (played-in, pickup)', () => {
    const expected: Record<string, boolean> = { demo: true, straight: true, performed: false, sixeight: false };
    for (const [name, make] of GOLDEN_SONGS) {
      const expectEvent = expected[name];
      const song = make();
      const level: Difficulty = 'hard';
      const sheet = ensureSheet(song, level);
      const t = buildSheet({ ...song, sheet }, level).time;
      const withMeter: Song = { ...song, sheet: { ...sheet, meters: [{ pos: t.measureStart(4), beatsPerBar: 3, beatUnit: 4 }] } };
      const ns = withMeter.arrangements[level];
      const bytes = exportMidi(ns.notes, ns.pedal, withMeter.tempo, name, sheetMidiMeta(withMeter, level));
      const all = sigs(bytes);
      const three = all.filter((x) => x.sig === '3/4');
      expect(three.length, name).toBe(expectEvent ? 1 : 0);
      if (expectEvent) {
        const ppq = new Midi(bytes).header.ppq;
        expect(three[0].ticks % (4 * ppq)).toBe(0);
      }
    }
  });
});

describe('small things', () => {
  it('Alt+← / → pick notes only with a selection or with the music focused (otherwise browser Back / Forward)', () => {
    const k = (code: string) => ({ code, key: code, shiftKey: false, altKey: true, ctrlKey: false, metaKey: false });
    expect(sheetKeyAction(k('ArrowRight'), false)).toBeNull();
    expect(sheetKeyAction(k('ArrowRight'), false, true)).toEqual({ type: 'selectNext', dir: 1 });
    expect(sheetKeyAction(k('ArrowLeft'), true)).toEqual({ type: 'selectNext', dir: -1 });
  });

  it('lengths without a single note value are named after their note values', () => {
    expect(lengthName(21)).toBe('double-dotted quarter');
    expect(lengthName(15)).toBe('quarter + 16th');
    expect(lengthName(12)).toBe('quarter');
  });

  it('the Score cache keeps only the last few arrangements', async () => {
    const song = straightSong();
    const first = buildSheet(song, 'hard');
    expect(buildSheet(song, 'hard')).toBe(first);
    for (let i = 0; i < 8; i++) buildSheet({ ...song, arrangements: { ...song.arrangements, hard: { ...song.arrangements.hard } } }, 'hard');
    expect(buildSheet(song, 'hard')).not.toBe(first);
  });
});
