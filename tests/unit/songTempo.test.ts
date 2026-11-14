/**
 * Setting the tempo of a song from sheet music (lib/sheet/retime.ts scaleSongTempo): every level
 * (Hard too), the notes the levels come from, the pedal, the beat grid, the length and the sheet's
 * locked grid follow by one factor; sheet positions, edits, fingering, marks and pins stay; tempo
 * changes later in the piece and fermatas keep their proportions; a round trip is exact. Plus where
 * an imported tempo comes from (marks, words, the page, the default) and the guess fixes, the MIDI
 * file tempo in quarters, and the tempo printed on a PDF page's text.
 */
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8 } from 'fflate';
import type { Note, Song, SheetMark } from '../../src/lib/music/types';
import { importMusicXml, readScoreFile, type ImportTempo } from '../../src/lib/score';
import { tempoNumberInText, tempoFromWords } from '../../src/lib/score/ir';
import { tempoFromPageText, topLines, type PageTextItem } from '../../src/lib/score/pageTempo';
import { buildSheet } from '../../src/lib/sheet';
import { ensureSheet } from '../../src/lib/sheet/lock';
import { gridFromLock } from '../../src/lib/sheet/grid';
import { followsWrittenTempo, retime, scaleSongTempo, songStart, songStartQpm, songTempoUnit } from '../../src/lib/sheet/retime';
import { sheetMidiMeta } from '../../src/lib/sheet/midiMeta';
import { exportMidi, parseMidi } from '../../src/lib/music/midi';
import { tempoQpm } from '../../src/lib/music/beats';
import { DIV } from '../../src/lib/sheet/types';
import { songFromScore } from '../../src/lib/songs';
import { performedSong, straightSong } from './sheetSongs';

vi.mock('../../src/lib/storage/db', async (orig) => ({ ...(await orig<object>()), getSong: vi.fn(), saveSong: vi.fn(async () => undefined) }));
vi.mock('../../src/state/playback', () => ({ getPlayer: () => ({ isPlaying: false, getTime: () => 0, liveNoteOn() {}, liveNoteOff() {} }) }));
vi.stubGlobal('window', { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: number) => clearTimeout(t) });
const { useStudio } = await import('../../src/state/studioStore');
const { deleteSelectedMark, setTempoAt } = await import('../../src/state/sheetMarks');
const { useToasts } = await import('../../src/state/toastStore');
const { tempoFrom, tempoGuessed } = await import('../../src/components/studio/panels/TempoControl');

const require = createRequire(import.meta.url);
const { Midi } = require('@tonejs/midi');

// ---------------------------------------------------------------- synthetic scores

const STEP = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const ALT = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const pitch = (m: number) => `<pitch><step>${STEP[m % 12]}</step>${ALT[m % 12] ? `<alter>${ALT[m % 12]}</alter>` : ''}<octave>${Math.floor(m / 12) - 1}</octave></pitch>`;
const note = (m: number, dur: number, staff: 1 | 2, more = '') => `<note>${pitch(m)}<duration>${dur}</duration><voice>${staff}</voice><staff>${staff}</staff>${more}</note>`;
const METRO = (bpm: number, unit = 'quarter', dot = false) =>
  `<direction placement="above"><direction-type><metronome><beat-unit>${unit}</beat-unit>${dot ? '<beat-unit-dot/>' : ''}<per-minute>${bpm}</per-minute></metronome></direction-type><staff>1</staff></direction>`;
const WORDS = (w: string) => `<direction placement="above"><direction-type><words>${w}</words></direction-type><staff>1</staff></direction>`;

interface ScoreOpts {
  bars?: number;
  beats?: number;
  beatType?: number;
  /** directions at the start of bar 1 */
  head?: string;
  /** directions at the start of a bar (1-based) */
  at?: Record<number, string>;
  /** a fermata on the first right-hand note of this bar (1-based) */
  fermataBar?: number;
  /** a second part */
  part2?: string;
}

/** A piano grand staff: right hand one note per beat, left hand one note per bar, pedal down each bar. */
function scoreXml(o: ScoreOpts = {}): string {
  const bars = o.bars ?? 8;
  const beats = o.beats ?? 4;
  const beatType = o.beatType ?? 4;
  const div = 2;
  const beatDur = (div * 4) / beatType;
  const bar = beats * beatDur;
  const scale = [60, 62, 64, 65, 67, 69, 71, 72];
  const ms: string[] = [];
  for (let b = 1; b <= bars; b++) {
    let s = '';
    if (b === 1) s += `<attributes><divisions>${div}</divisions><key><fifths>0</fifths></key><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`;
    if (b === 1 && o.head) s += o.head;
    if (o.at?.[b]) s += o.at[b];
    s += '<direction><direction-type><pedal type="start"/></direction-type><staff>2</staff></direction>';
    for (let i = 0; i < beats; i++) s += note(scale[(b + i) % 8] + 12, beatDur, 1, i === 0 && o.fermataBar === b ? '<notations><fermata/></notations>' : '');
    s += `<backup><duration>${bar}</duration></backup>`;
    s += note(48 + (b % 5), bar, 2);
    s += `<direction><direction-type><pedal type="stop"/></direction-type><offset>${bar - 1}</offset><staff>2</staff></direction>`;
    ms.push(`<measure number="${b}">${s}</measure>`);
  }
  const p2 = o.part2 ? `<part id="P2">${o.part2}</part>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part>${
    o.part2 ? '<score-part id="P2"><part-name>Violin</part-name></score-part>' : ''
  }</part-list><part id="P1">${ms.join('')}</part>${p2}</score-partwise>`;
}

const songOf = (xml: string, tempo?: ImportTempo, reader = false): Song =>
  songFromScore(importMusicXml(xml, { fileName: 'synthetic.musicxml', ...(tempo ? { tempo } : {}) }), {
    kind: 'score',
    fileName: 'synthetic.musicxml',
    ...(reader ? { reader: 'pdf' as const, sheetReader: 'accurate' as const } : {}),
  });

/** Right-hand note starts of a level, in seconds. */
const rhStarts = (song: Song, lv: 'easy' | 'medium' | 'hard' = 'hard') =>
  song.arrangements[lv].notes
    .filter((n) => n.hand === 'R')
    .map((n) => n.start)
    .sort((a, b) => a - b);

/** Seconds of each written bar of the Hard sheet. */
function barSeconds(song: Song): number[] {
  const s = buildSheet(song, 'hard');
  const out: number[] = [];
  for (let m = 0; m < s.measureCount; m++) out.push(s.measureStartTimes[m + 1] - s.measureStartTimes[m]);
  return out;
}

const written = (song: Song, lv: 'easy' | 'medium' | 'hard') => buildSheet(song, lv).notes.map((n) => [n.midi, n.on, n.off, n.staff]);
const apply = (song: Song, patch: Partial<Song>): Song => ({ ...song, ...patch });

// ---------------------------------------------------------------- scaleSongTempo

describe('setting the tempo of a sheet-music song', () => {
  it('a reader song with no tempo starts at the default 120 and says so; Hard follows a new tempo exactly', () => {
    const song = songOf(scoreXml(), undefined, true);
    expect(song.tempo.from).toBe('default');
    expect(songStartQpm(song)).toBe(120);
    expect(followsWrittenTempo(song)).toBe(true);
    const hard0 = rhStarts(song);
    expect(hard0.slice(0, 3)).toEqual([0, 0.5, 1]);
    const { patch, k } = scaleSongTempo(song, 60, 'q');
    expect(k).toBe(2);
    const s1 = apply(song, patch);
    expect(rhStarts(s1)).toEqual(hard0.map((t) => t * 2));
    for (const lv of ['easy', 'medium', 'hard'] as const) {
      song.arrangements[lv].notes.forEach((n, i) => {
        expect(s1.arrangements[lv].notes[i].start).toBeCloseTo(n.start * 2, 12);
        expect(s1.arrangements[lv].notes[i].dur).toBeCloseTo(n.dur * 2, 12);
        expect(s1.arrangements[lv].notes[i].id).toBe(n.id);
      });
      song.arrangements[lv].pedal.forEach((p, i) => expect(s1.arrangements[lv].pedal[i]).toEqual({ start: p.start * 2, end: p.end * 2 }));
    }
    expect(s1.base.map((n) => n.start)).toEqual(song.base.map((n) => n.start * 2));
    expect(s1.basePedal.length).toBeGreaterThan(0);
    expect(s1.basePedal).toEqual(song.basePedal.map((p) => ({ start: p.start * 2, end: p.end * 2 })));
    expect(s1.tempo.beats).toEqual(song.tempo.beats.map((b) => b * 2));
    expect(s1.duration).toBe(song.duration * 2);
    expect(s1.tempo).toMatchObject({ bpm: 60, qpm: 60, from: 'set', source: 'midi' });
    // the sheet: the same notes in the same bars, now marked 60
    for (const lv of ['easy', 'medium', 'hard'] as const) expect(written(s1, lv)).toEqual(written(song, lv));
    expect(buildSheet(s1, 'hard').measureCount).toBe(8);
    expect(buildSheet(s1, 'hard').tempoMarks).toEqual([{ measure: 0, bpm: 60, qpm: 60 }]);
    expect(barSeconds(s1)).toEqual(barSeconds(song).map((x) => x * 2));
  });

  it('keeps edits, fingering, markings and pins, with or without the locked grid', () => {
    const song0 = songOf(scoreXml());
    const locked: Song = { ...song0, sheet: ensureSheet(song0, 'hard') };
    const target = locked.arrangements.hard.notes[5];
    const marks: SheetMark[] = [{ id: 'd1', kind: 'dyn', pos: 24, staff: 1, value: 'p' }, { id: 's1', kind: 'slur', from: locked.arrangements.hard.notes[1].id, to: locked.arrangements.hard.notes[3].id }];
    const edited: Song = {
      ...locked,
      arrangements: {
        ...locked.arrangements,
        hard: {
          ...locked.arrangements.hard,
          edited: true,
          marks,
          notes: locked.arrangements.hard.notes.map((n): Note =>
            n.id === target.id ? { ...n, finger: 3, art: ['staccato'], artBase: { dur: n.dur * 2 }, pin: { on: 30, off: 33, t: n.start, d: n.dur } } : n,
          ),
        },
      },
    };
    for (const song of [song0, edited]) {
      const s1 = apply(song, scaleSongTempo(song, 76, 'q').patch);
      expect(s1.arrangements.hard.edited).toBe(song.arrangements.hard.edited);
      expect(s1.arrangements.hard.marks).toEqual(song.arrangements.hard.marks);
      for (const lv of ['easy', 'medium', 'hard'] as const) expect(written(s1, lv)).toEqual(written(song, lv));
      if (song.sheet) {
        const n1 = s1.arrangements.hard.notes.find((n) => n.id === target.id)!;
        expect(n1.finger).toBe(3);
        expect(n1.art).toEqual(['staccato']);
        expect(n1.pin).toEqual({ on: 30, off: 33, t: n1.start, d: n1.dur });
        expect(n1.artBase!.dur).toBeCloseTo(n1.dur * 2, 12);
        // every note, pedal and beat at the same place on the locked grid
        const g0 = gridFromLock(song.sheet.grid, song.tempo.source);
        const g1 = gridFromLock(s1.sheet!.grid, s1.tempo.source);
        song.arrangements.hard.notes.forEach((n, i) => expect(g1.toPos(s1.arrangements.hard.notes[i].start)).toBeCloseTo(g0.toPos(n.start), 6));
        song.arrangements.hard.pedal.forEach((p, i) => expect(g1.toPos(s1.arrangements.hard.pedal[i].end)).toBeCloseTo(g0.toPos(p.end), 6));
        song.tempo.beats.forEach((b, i) => expect(g1.toPos(s1.tempo.beats[i])).toBeCloseTo(g0.toPos(b), 6));
        expect(s1.sheet!.grid.bpm).toBeCloseTo((song.sheet.grid.bpm * 76) / 120, 9);
      }
    }
  });

  it('tempo changes later in the piece and fermatas keep their proportions', () => {
    const song = songOf(scoreXml({ bars: 7, head: METRO(100), fermataBar: 4, at: { 5: WORDS('Adagio') } }));
    const before = barSeconds(song);
    expect(before.map((x) => +x.toFixed(3))).toEqual([2.4, 2.4, 2.4, 2.7, 3.636, 3.636, 3.636]);
    const s1 = apply(song, scaleSongTempo(song, 80, 'q').patch);
    const after = barSeconds(s1);
    after.forEach((x, i) => expect(x).toBeCloseTo(before[i] * 1.25, 9));
    expect(after[3] / after[0]).toBeCloseTo(before[3] / before[0], 9);
    expect(after[4] / after[0]).toBeCloseTo(100 / 66, 6);
    // the written tempo change is still on the sheet, scaled with the start
    const marks = buildSheet(s1, 'hard').tempoMarks;
    expect(marks[0]).toMatchObject({ measure: 0, bpm: 80 });
    expect(marks.find((m) => m.measure === 4)?.bpm).toBe(Math.round((66 * 80) / 100));
  });

  it('a round trip 72 → 144 → 72 gives the same seconds back (and the same sheet)', () => {
    const song = songOf(scoreXml({ head: METRO(72) }));
    const locked: Song = { ...song, sheet: ensureSheet(song, 'hard') };
    for (const s0 of [song, locked]) {
      const up = apply(s0, scaleSongTempo(s0, 144, 'q').patch);
      expect(up.duration).toBeCloseTo(s0.duration / 2, 12);
      const back = apply(up, scaleSongTempo(up, 72, 'q').patch);
      for (const lv of ['easy', 'medium', 'hard'] as const) {
        s0.arrangements[lv].notes.forEach((n, i) => {
          expect(Math.abs(back.arrangements[lv].notes[i].start - n.start)).toBeLessThan(1e-6);
          expect(Math.abs(back.arrangements[lv].notes[i].dur - n.dur)).toBeLessThan(1e-6);
        });
        expect(written(back, lv)).toEqual(written(s0, lv));
      }
      expect(Math.abs(back.duration - s0.duration)).toBeLessThan(1e-6);
      back.tempo.beats.forEach((b, i) => expect(Math.abs(b - s0.tempo.beats[i])).toBeLessThan(1e-6));
      expect(back.tempo.bpm).toBe(72);
      if (s0.sheet) back.sheet!.grid.beats.forEach((b, i) => expect(Math.abs(b - s0.sheet!.grid.beats[i])).toBeLessThan(1e-6));
      // an odd factor too
      const odd = apply(apply(s0, scaleSongTempo(s0, 97.3, 'q').patch), {});
      const odd2 = apply(odd, scaleSongTempo(odd, 72, 'q').patch);
      s0.arrangements.hard.notes.forEach((n, i) => expect(Math.abs(odd2.arrangements.hard.notes[i].start - n.start)).toBeLessThan(1e-6));
    }
  });

  it('6/8: shown and set in dotted quarters; the sheet grid stays consistent', () => {
    const song = songOf(scoreXml({ beats: 6, beatType: 8, head: METRO(60, 'quarter', true) }));
    expect(songStartQpm(song)).toBe(90);
    expect(songTempoUnit(song)).toBe('q.');
    expect(song.tempo.bpm).toBe(180);
    const s1 = apply(song, scaleSongTempo(song, 40, 'q.').patch);
    expect(songStartQpm(s1)).toBe(60);
    expect(s1.tempo.bpm).toBe(120);
    expect(buildSheet(s1, 'hard').tempoMarks[0]).toMatchObject({ measure: 0, bpm: 40 });
    expect(written(s1, 'hard')).toEqual(written(song, 'hard'));
    expect(s1.duration).toBeCloseTo(song.duration * 1.5, 12);
  });

  it('a tempo set later on the sheet keeps its speed; label-only and start marks take the new value', () => {
    const song0 = songOf(scoreXml());
    const sheet = ensureSheet(song0, 'hard');
    const t = gridFromLock(sheet.grid, song0.tempo.source);
    const pos4 = t.measureStart(4);
    let song: Song = { ...song0, sheet: { ...sheet, tempos: [{ pos: pos4, bpm: 90, unit: 'q', retimed: true }] } };
    song = apply(song, retime(song, pos4, 90).patch);
    const before = barSeconds(song);
    const r = scaleSongTempo(song, 60, 'q');
    const s1 = apply(song, r.patch);
    expect(r.keptFrom).toHaveLength(1);
    // bars 1-4 twice as long, bar 5 on at the tempo typed there
    expect(s1.sheet!.tempos).toEqual([{ pos: pos4, bpm: 90, unit: 'q', retimed: true }]);
    barSeconds(s1).forEach((x, i) => expect(x).toBeCloseTo(before[i] * (i < 4 ? 2 : 1), 9));
    expect(JSON.stringify(written(s1, 'hard'))).toBe(JSON.stringify(written(song, 'hard')));
    expect(sheetMidiMeta(s1, 'hard')!.tempos).toEqual([{ time: expect.any(Number), qpm: 90 }]);
    expect(s1.duration).toBeCloseTo(song.duration + barSeconds(song).slice(0, 4).reduce((x, y) => x + y, 0), 9);
    // a start mark from the sheet: bar 1 at ♩ = 100 with a mark, then the Studio sets 50
    const withMark = apply(s1, scaleSongTempo(s1, 100, 'q', { mark: true, text: 'Allegretto' }).patch);
    expect(withMark.sheet!.tempos![0]).toEqual({ pos: 0, bpm: 100, unit: 'q', text: 'Allegretto', retimed: true });
    expect(withMark.sheet!.tempos![1].bpm).toBe(90);
    expect(songStartQpm(withMark)).toBe(100);
    const s2 = apply(withMark, scaleSongTempo(withMark, 50, 'q').patch);
    expect(s2.sheet!.tempos![0]).toEqual({ pos: 0, bpm: 50, unit: 'q', text: 'Allegretto', retimed: true });
    const marks = buildSheet(s2, 'hard').tempoMarks;
    expect(marks[0]).toMatchObject({ measure: 0, bpm: 50, text: 'Allegretto' });
    expect(marks.at(-1)).toMatchObject({ measure: 4, bpm: 90 });
    expect(barSeconds(s2)[6]).toBeCloseTo(before[6], 9);
    // and back: the seconds return
    const back = apply(s2, scaleSongTempo(s2, 120, 'q').patch);
    back.arrangements.hard.notes.forEach((n, i) => expect(n.start).toBeCloseTo(song.arrangements.hard.notes[i].start, 6));
  });

  it('an eighth-note tempo later on the sheet is kept as typed (no clamp) when the start doubles', () => {
    const song0 = songOf(scoreXml());
    const sheet = ensureSheet(song0, 'hard');
    const pos4 = gridFromLock(sheet.grid, song0.tempo.source).measureStart(4);
    let song: Song = { ...song0, sheet: { ...sheet, tempos: [{ pos: pos4, bpm: 240, unit: 'e', retimed: true }] } };
    song = apply(song, retime(song, pos4, 120).patch);
    const up = apply(song, scaleSongTempo(song, 240, 'q').patch);
    expect(up.sheet!.tempos![0].bpm).toBe(240);
    expect((8 * 60) / barSeconds(up)[5]).toBeCloseTo(240, 6);
    expect(sheetMidiMeta(up, 'hard')!.tempos).toEqual([{ time: expect.any(Number), qpm: 120 }]);
    const back = apply(up, scaleSongTempo(up, 120, 'q').patch);
    expect(back.sheet!.tempos![0].bpm).toBe(240);
  });

  it('a label-only tempo mark on bar 1 says the new tempo', () => {
    const song0 = songOf(scoreXml());
    const sheet = ensureSheet(song0, 'hard');
    const song: Song = { ...song0, sheet: { ...sheet, tempos: [{ pos: 0, bpm: 120, unit: 'q', text: 'Allegro', retimed: false }] } };
    const s1 = apply(song, scaleSongTempo(song, 60, 'q').patch);
    expect([songStartQpm(s1), buildSheet(s1, 'hard').tempoMarks[0].bpm, buildSheet(s1, 'hard').tempoMarks[0].text]).toEqual([60, 60, 'Allegro']);
  });

  it('a played-in MIDI file: the start is the sheet\'s tempo, and setting it keeps the bars', () => {
    const song = performedSong();
    expect(followsWrittenTempo(song)).toBe(true);
    const shown = buildSheet(song, 'hard').tempoMarks[0].qpm;
    expect(songStart(song).by).toBe('sheet');
    expect(Math.abs(songStartQpm(song) - shown)).toBeLessThan(5);
    const w0 = written(song, 'hard');
    for (const q of [60, shown, 120, 200]) {
      const s1 = apply(song, scaleSongTempo(song, q, 'q').patch);
      expect(s1.sheet).toBeDefined();
      expect(JSON.stringify(written(s1, 'hard'))).toBe(JSON.stringify(w0));
      expect(songStartQpm(s1)).toBeCloseTo(q, 6);
      expect(buildSheet(s1, 'hard').tempoMarks[0].bpm).toBe(Math.round(q));
      // a sheet edit locked earlier: the same
      const locked: Song = { ...song, sheet: ensureSheet(song, 'hard') };
      expect(songStartQpm(locked)).toBeCloseTo(songStartQpm(song), 6);
      const s2 = apply(locked, scaleSongTempo(locked, q, 'q').patch);
      expect(JSON.stringify(written(s2, 'hard'))).toBe(JSON.stringify(w0));
    }
    // a quantized MIDI file follows its own tempo
    expect(songStart(straightSong()).by).toBe('tempo');
  });

  it('older songs: bar 1 re-timed before the tempo was kept, its mark deleted since', () => {
    const song0 = songOf(scoreXml(), undefined, true);
    const sheet = ensureSheet(song0, 'hard');
    let song: Song = { ...song0, sheet: { ...sheet, tempos: [{ pos: 0, bpm: 60, unit: 'q', retimed: true }] } };
    const p = retime(song, 0, 60).patch;
    // the old re-time left the song tempo alone (no qpm / from) and the grid's bpm too
    const stale = { ...p.tempo, bpm: song0.tempo.bpm } as Song['tempo'];
    delete stale.qpm;
    delete stale.from;
    song = apply(song, { ...p, tempo: stale, sheet: { ...p.sheet!, grid: { ...p.sheet!.grid, bpm: sheet.grid.bpm } } });
    expect([songStartQpm(song), tempoFrom(song), tempoGuessed(song)]).toEqual([60, 'set', false]);
    const del: Song = { ...song, sheet: { ...song.sheet! } };
    delete del.sheet!.tempos;
    expect((4 * 60) / barSeconds(del)[0]).toBeCloseTo(60, 6);
    expect(songStartQpm(del)).toBeCloseTo(60, 6);
    expect(tempoFrom(del)).toBe('set');
    const s1 = apply(del, scaleSongTempo(del, 90, 'q').patch);
    expect((4 * 60) / barSeconds(s1)[0]).toBeCloseTo(90, 6);
    // an older song that was never re-timed is still a guess
    const plain = { ...song0, tempo: { ...song0.tempo } };
    delete plain.tempo.qpm;
    delete plain.tempo.from;
    expect([tempoFrom(plain), tempoGuessed(plain)]).toEqual(['default', true]);
    expect(tempoFrom({ ...plain, sheet: ensureSheet(plain, 'hard') })).toBe('default');
  });

  it('a re-time from bar 1 updates the song tempo too', () => {
    const song0 = songOf(scoreXml(), undefined, true);
    const sheet = ensureSheet(song0, 'hard');
    const t = gridFromLock(sheet.grid, song0.tempo.source);
    const pos3 = t.measureStart(3);
    const song: Song = { ...song0, sheet: { ...sheet, tempos: [{ pos: 0, bpm: 80, unit: 'q', retimed: true }, { pos: pos3, bpm: 100, unit: 'q', retimed: true }] } };
    const { patch } = retime(song, 0, 80);
    expect(patch.tempo).toMatchObject({ bpm: 80, qpm: 80, from: 'set' });
    expect(barSeconds(apply(song, patch))[0]).toBeCloseTo(3, 9);
  });

  it('is refused for songs that follow a recording or a hands video', () => {
    const song = songOf(scoreXml());
    expect(() => scaleSongTempo({ ...song, hasAudio: true }, 60, 'q')).toThrow();
    expect(() => scaleSongTempo({ ...song, handVideo: {} as Song['handVideo'] }, 60, 'q')).toThrow();
    expect(followsWrittenTempo({ ...song, hasAudio: true })).toBe(false);
    expect(followsWrittenTempo({ ...song, transcription: { ...song.transcription, method: 'basic-pitch' } })).toBe(false);
    expect(followsWrittenTempo(straightSong())).toBe(true);
  });
});

// ---------------------------------------------------------------- the sheet editor's bar-1 tempo mark, undo

describe('tempo mark on bar 1 (sheet editor) and undo', () => {
  beforeEach(() => {
    const song = songOf(scoreXml({ bars: 7, head: METRO(100), fermataBar: 4, at: { 5: WORDS('Adagio') } }));
    useStudio.setState({ song, difficulty: 'hard', past: [], future: [], selection: new Set(), editMode: true });
  });

  it('scales the whole song (fermata and Adagio kept) as one undo step', () => {
    const st = useStudio.getState;
    const s0 = st().song!;
    const before = barSeconds(s0);
    expect(setTempoAt(0, 50, 'q', '', true)).toBe(true);
    const s1 = st().song!;
    barSeconds(s1).forEach((x, i) => expect(x).toBeCloseTo(before[i] * 2, 9));
    expect(s1.tempo).toMatchObject({ bpm: 50, qpm: 50, from: 'set' });
    expect(s1.sheet!.tempos).toEqual([{ pos: 0, bpm: 50, unit: 'q', retimed: true }]);
    expect(rhStarts(s1)).toEqual(rhStarts(s0).map((t) => t * 2));
    expect(st().past).toHaveLength(1);
    st().undo();
    expect(st().song!.arrangements).toBe(s0.arrangements);
    expect(st().song!.tempo).toBe(s0.tempo);
    expect(st().song!.duration).toBe(s0.duration);
    expect('sheet' in st().song!).toBe(false);
  });

  it('says nothing about a recording when bar 1 changes the speed', () => {
    useToasts.setState({ toasts: [] });
    expect(setTempoAt(0, 80, 'q', '', true)).toBe(true);
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual([]);
    expect(songStartQpm(useStudio.getState().song!)).toBe(80);
  });

  it('bar 1 with a tempo set later: scaled up to it, the later tempo stays', () => {
    const st = useStudio.getState;
    const t = buildSheet(st().song!, 'hard').time;
    expect(setTempoAt(5, 60, 'q', '', true)).toBe(true);
    const s1 = st().song!;
    const before = barSeconds(s1);
    expect(setTempoAt(0, 50, 'q', '', true)).toBe(true);
    const s2 = st().song!;
    barSeconds(s2).forEach((x, i) => expect(x).toBeCloseTo(before[i] * (i < 5 ? 2 : 1), 9));
    expect(s2.sheet!.tempos!.find((x) => x.pos === t.measureStart(5))!.bpm).toBe(60);
  });

  it('deleting the re-timed start mark keeps the speed and the song says it', () => {
    const st = useStudio.getState;
    setTempoAt(0, 80, 'q', '', true);
    useStudio.setState({ markSel: 'tempo:0' });
    expect(deleteSelectedMark()).toBe(true);
    const s = st().song!;
    expect(s.sheet?.tempos).toBeUndefined();
    expect(s.tempo).toMatchObject({ qpm: 80, from: 'set' });
    expect(songStartQpm(s)).toBe(80);
    expect((4 * 60) / barSeconds(s)[0]).toBeCloseTo(80, 6);
  });

  it('the Studio tempo is one undo step', () => {
    const st = useStudio.getState;
    const s0 = st().song!;
    st().editSong((s) => scaleSongTempo(s, 66, 'q').patch);
    expect(songStartQpm(st().song!)).toBe(66);
    st().undo();
    expect(st().song!.base).toBe(s0.base);
    expect(st().song!.tempo).toBe(s0.tempo);
    st().redo();
    expect(songStartQpm(st().song!)).toBe(66);
  });
});

// ---------------------------------------------------------------- where the imported tempo comes from

describe('imported tempo', () => {
  const start = (xml: string, tempo?: ImportTempo) => {
    const p = importMusicXml(xml, tempo ? { tempo } : {});
    const rh = p.notes.filter((n) => n.hand === 'R');
    return { tempo: p.tempo, qpm: +(60 / (rh[1].start - rh[0].start)).toFixed(3) };
  };

  it('metronome mark, words, nothing', () => {
    expect(start(scoreXml({ head: METRO(72) }))).toMatchObject({ qpm: 72, tempo: { from: 'mark', qpm: 72, bpm: 72 } });
    expect(start(scoreXml({ head: WORDS('Andante') }))).toMatchObject({ qpm: 76, tempo: { from: 'words', fromText: 'Andante' } });
    expect(start(scoreXml())).toMatchObject({ qpm: 120, tempo: { from: 'default', qpm: 120 } });
  });

  it('an explicit mark wins over tempo words at the same place, in either order and in any part', () => {
    expect(start(scoreXml({ head: METRO(60) + WORDS('Allegro') }))).toMatchObject({ qpm: 60, tempo: { bpm: 60, from: 'mark' } });
    expect(start(scoreXml({ head: WORDS('Allegro') + METRO(60) }))).toMatchObject({ qpm: 60, tempo: { bpm: 60, from: 'mark' } });
    const presto = `<measure number="1"><attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${WORDS('Presto')}<note><rest/><duration>8</duration></note></measure>`;
    const sound = '<direction><direction-type><words> </words></direction-type><sound tempo="60"/></direction>';
    expect(start(scoreXml({ head: sound, part2: presto }))).toMatchObject({ qpm: 60, tempo: { bpm: 60 } });
  });

  it('a metronome mark typed as words', () => {
    expect(start(scoreXml({ head: WORDS('♩ = 72') }))).toMatchObject({ qpm: 72, tempo: { from: 'mark' } });
    expect(start(scoreXml({ head: WORDS('Andante ♩=72') }))).toMatchObject({ qpm: 72, tempo: { from: 'mark' } });
    expect(start(scoreXml({ head: WORDS('(q = c. 96)') }))).toMatchObject({ qpm: 96 });
    // dotted quarter in 6/8: the eighth notes at 60·1.5·2 a minute
    const p = importMusicXml(scoreXml({ beats: 6, beatType: 8, head: WORDS('♩. = 60') }));
    expect(p.tempo.qpm).toBe(90);
    // an unreadable note glyph: the meter's beat
    expect(importMusicXml(scoreXml({ beats: 6, beatType: 8, head: WORDS(' = 60') })).tempo.qpm).toBe(90);
    expect(importMusicXml(scoreXml({ beats: 2, beatType: 2, head: WORDS('= 60') })).tempo.qpm).toBe(120);
  });

  it('English and German tempo words', () => {
    expect(tempoFromWords('Moderately slow')).toBe(84);
    expect(tempoFromWords('Moderately')).toBe(104);
    expect(tempoFromWords('Slowly, with feeling')).toBe(66);
    expect(tempoFromWords('Brightly')).toBe(144);
    expect(tempoFromWords('Langsam')).toBe(60);
    expect(tempoFromWords('Mäßig')).toBe(100);
    expect(tempoFromWords('Allegro moderato')).toBe(132);
    expect(tempoNumberInText('Tempo: ♩ = 104')).toEqual({ bpm: 104, unit: 'q' });
    expect(tempoNumberInText('𝅗𝅥 = 60')).toEqual({ bpm: 60, unit: 'h' });
    expect(tempoNumberInText('Andante')).toBeNull();
    expect(tempoNumberInText('= 7')).toBeNull();
  });

  it('a tempo given at import: from the page when the score has none; typed always sets the start', () => {
    expect(start(scoreXml(), { bpm: 72, unit: null, from: 'page', text: '= 72' })).toMatchObject({ qpm: 72, tempo: { from: 'page', fromText: '= 72', qpm: 72 } });
    expect(start(scoreXml({ head: METRO(100) }), { bpm: 72, unit: 'q', from: 'page' })).toMatchObject({ qpm: 100, tempo: { from: 'mark' } });
    expect(start(scoreXml(), { bpm: 66, unit: 'q', from: 'page', text: 'Adagio', guess: true })).toMatchObject({ qpm: 66, tempo: { from: 'words' } });
    // typed: the start is set and a later change keeps its proportion
    const xml = scoreXml({ bars: 7, head: METRO(100), at: { 5: METRO(50) } });
    const p = importMusicXml(xml, { tempo: { bpm: 80, unit: 'q', from: 'set' } });
    expect(p.tempo).toMatchObject({ qpm: 80, from: 'set' });
    const s = songFromScore(p, { kind: 'score' });
    const bars = barSeconds(s);
    expect(bars[0]).toBeCloseTo(3, 9);
    expect(bars[5]).toBeCloseTo(6, 9);
  });

  it('MuseScore: a tempo on the second staff or in voice 2 is read', () => {
    const C = (p: number) => `<Chord><durationType>quarter</durationType><Note><pitch>${p}</pitch></Note></Chord>`;
    const x = (staff2: string) =>
      `<?xml version="1.0" encoding="UTF-8"?><museScore version="4.20"><Score><Division>480</Division><Part><Instrument id="piano"><longName>Piano</longName><instrumentId>keyboard.piano</instrumentId></Instrument><Staff><StaffType group="pitched"/></Staff><Staff><StaffType group="pitched"/></Staff></Part><Staff id="1"><Measure><voice><TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig>${C(72)}${C(74)}${C(76)}${C(77)}</voice></Measure></Staff><Staff id="2"><Measure><voice><TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig>${staff2}<Chord><durationType>whole</durationType><Note><pitch>48</pitch></Note></Chord></voice></Measure></Staff></Score></museScore>`;
    const p = readScoreFile('piece.mscx', strToU8(x('<Tempo><tempo>1.2</tempo></Tempo>')));
    expect(p.tempo.qpm).toBeCloseTo(72, 9);
    expect(p.notes.filter((n) => n.hand === 'R')[1].start).toBeCloseTo(60 / 72, 9);
  });
});

// ---------------------------------------------------------------- MIDI files count in quarters

describe('MIDI tempo in quarter notes', () => {
  it('a 6/8 score song is written with its quarter tempo; a 6/8 MIDI file counts eighths like a score', () => {
    const song = songOf(scoreXml({ beats: 6, beatType: 8, head: METRO(60, 'quarter', true) }));
    const bytes = exportMidi(song.arrangements.hard.notes, song.arrangements.hard.pedal, { ...song.tempo, qpm: tempoQpm(song.tempo) }, 'x');
    const m = new Midi(bytes);
    expect(m.header.tempos[0].bpm).toBeCloseTo(90, 3);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const back = parseMidi(buf);
    expect(back.tempo).toMatchObject({ bpm: 180, beatUnit: 8 });
    expect(back.tempo.qpm).toBeCloseTo(90, 3);
    // old MIDI-file songs stored the file's quarter tempo as bpm
    expect(tempoQpm({ ...back.tempo, qpm: undefined, bpm: 90 }, true)).toBe(90);
    expect(tempoQpm({ ...back.tempo, qpm: undefined })).toBe(90);
  });
});

// ---------------------------------------------------------------- the tempo printed on a PDF page

describe('tempo from a PDF page text', () => {
  const H = 842;
  const item = (str: string, x: number, y: number, h = 12): PageTextItem => ({ str, x, y, h });
  it('reads a metronome mark from the top of the page, split runs joined', () => {
    const items = [item('Little Waltz', 250, 800, 20), item('Andante', 60, 760), item('', 60, 745), item('= 72', 72, 745), item('Composer', 450, 760), item('= 99', 60, 100)];
    expect(topLines(items, H)).toEqual(['Little Waltz', 'Andante Composer', ' = 72']);
    expect(tempoFromPageText(items, H)).toEqual({ bpm: 72, unit: null, text: ' = 72', guess: false });
  });
  it('tempo words alone are a guess; nothing found is null', () => {
    expect(tempoFromPageText([item('Andante', 60, 760)], H)).toMatchObject({ bpm: 76, guess: true });
    expect(tempoFromPageText([item('A Sonata in the style of an Allegro', 60, 760)], H)).toBeNull();
    expect(tempoFromPageText([item('q = 80', 60, 300)], H)).toBeNull();
  });
});

describe('time per written bar', () => {
  it('sanity: 8 bars of 4/4 at 120 are 2 s each', () => {
    const s = songOf(scoreXml());
    expect(barSeconds(s)).toEqual(Array(8).fill(2));
    expect(buildSheet(s, 'hard').time.measureLenAt(0)).toBe(4 * DIV);
  });
});
