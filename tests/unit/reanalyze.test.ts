/**
 * "Analyze again" (the song's stored recording analyzed once more) and "Reset {Level} to detected
 * notes": which song fields are replaced, removed or kept, the loss text, what the song was analyzed
 * with, whether it can be analyzed again, and what a reset changes. Synthetic notes only.
 */
import { describe, expect, it } from 'vitest';
import type { Note, PedalRange, Song, TranscriptionInfo } from '../../src/lib/music/types';
import type { TranscriptionResult } from '../../src/lib/transcription/pipeline';
import { EXTRACTION_PRESETS } from '../../src/lib/transcription/pipeline';
import {
  ANALYSIS_KEYS,
  KEPT_KEYS,
  REMOVED_KEYS,
  arrangementOptions,
  buildSong,
  joinAnd,
  lossText,
  lostWork,
  resetLevel,
  resetToastBody,
  songFromReanalysis,
  songInputFromResult,
  withAnalysisOf,
} from '../../src/lib/songs';
import { generateAllArrangements } from '../../src/lib/music/difficulty';
import { analysisLabel, presetOfInfo, sameAsLast } from '../../src/lib/transcription/analysisSummary';
import { reanalyzeSupport } from '../../src/lib/reanalyze';

/** a made-up phrase: broken C and G chords, both hands */
function phrase(offset = 0, len = 0.45): Note[] {
  const out: Note[] = [];
  let id = 1;
  for (let b = 0; b < 8; b++) {
    const chord = b % 2 ? [43, 55, 59, 62, 67] : [48, 60, 64, 67, 72];
    chord.forEach((m, i) => out.push({ id: id++, midi: m, start: offset + b * 1 + i * 0.12, dur: len, vel: 0.6, hand: m < 60 ? 'L' : 'R' }));
  }
  return out;
}
const tempo = { bpm: 120, beats: Array.from({ length: 24 }, (_, i) => i * 0.5), beatsPerBar: 4, downbeatIndex: 0, confidence: 0.8, source: 'estimated' as const };
const bpInfo = (extra: Partial<TranscriptionInfo> = {}): TranscriptionInfo => ({ method: 'basic-pitch', estimated: true, params: EXTRACTION_PRESETS.piano, backend: 'wasm', warnings: [], ...extra });
const specInfo = (extra: Partial<TranscriptionInfo> = {}): TranscriptionInfo => ({ method: 'piano-specialist', estimated: true, backend: 'wasm (4 threads)', warnings: [], ...extra });

function bpResult(): TranscriptionResult {
  return { notes: phrase(0, 0.9), duration: 10, tempo, info: bpInfo(), posteriors: { nFrames: 1 } as unknown as TranscriptionResult['posteriors'] };
}
function specialistResult(): TranscriptionResult {
  const pedal: PedalRange[] = Array.from({ length: 8 }, (_, b) => ({ start: b + 0.05, end: b + 0.95 }));
  return { notes: phrase(0.02, 0.12), pedal, duration: 10, tempo: { ...tempo, bpm: 118 }, info: specInfo() };
}

/** an imported Basic Pitch song with everything a user can add to it */
function fullSong(): Song {
  const s = buildSong(songInputFromResult(bpResult(), { title: 'Practice piece', artist: 'Me', source: { kind: 'audio', fileName: 'piece.wav', mimeType: 'audio/wav', fileSize: 1000 } }));
  const hard = s.arrangements.hard;
  return {
    ...s,
    id: 'song-1',
    createdAt: 1,
    updatedAt: 2,
    lastPlayedAt: 3,
    favorite: true,
    noteLength: 'heard',
    notesAsPlayed: { base: s.base, pedal: [] },
    handVideo: { store: 'audio', name: 'piece.mp4', type: 'video/mp4', size: 1, width: 1, height: 1, duration: 10, offset: 0.25 } as unknown as Song['handVideo'],
    sheet: { v: 1, grid: { beats: [0, 0.5, 1], db: 0, bpm: 120, beatsPerBar: 4, beatUnit: 4, originQ: 0, pickup: 0 } },
    arrangements: {
      ...s.arrangements,
      hard: { ...hard, edited: true, notes: hard.notes.map((n, i) => (i === 0 ? { ...n, midi: n.midi + 1, finger: 1 as const } : n)), marks: [{ kind: 'dyn', pos: 0 } as never], pedalEdited: true, showPedal: true },
      easy: { ...s.arrangements.easy, edited: true },
    },
  };
}

describe('song fields on "Analyze again"', () => {
  it('every Song field is replaced, removed or kept (a new field must be sorted into one of them)', () => {
    const song = fullSong();
    // every optional field a song can have, set
    const all = { ...song, key: song.key ?? { tonic: 0, mode: 'major', name: 'C major' }, autoPedal: true, thumbnail: 'data:', hasPosteriors: true } as Song;
    const sorted = new Set<string>([...ANALYSIS_KEYS, ...REMOVED_KEYS, ...KEPT_KEYS]);
    expect(Object.keys(all).filter((k) => !sorted.has(k))).toEqual([]);
    // and none is in two lists
    expect(sorted.size).toBe(ANALYSIS_KEYS.length + REMOVED_KEYS.length + KEPT_KEYS.length);
    // the Song type's keys, as a compile-time check: a key missing here fails `tsc`
    const typed: Record<keyof Required<Song>, true> = {
      id: true, title: true, artist: true, createdAt: true, updatedAt: true, lastPlayedAt: true, duration: true, source: true, tempo: true, key: true,
      transcription: true, base: true, basePedal: true, arrangements: true, thumbnail: true, hasAudio: true, hasPosteriors: true, favorite: true,
      autoPedal: true, noteLength: true, notesAsPlayed: true, handVideo: true, sheet: true,
    };
    expect(Object.keys(typed).filter((k) => !sorted.has(k))).toEqual([]);
  });

  it('the high-accuracy model: notes as played with the recorded pedal, every level rebuilt; the song itself stays', () => {
    const old = fullSong();
    const next = songFromReanalysis(old, specialistResult(), 1000);
    // kept
    for (const k of KEPT_KEYS) if (k !== 'updatedAt') expect(next[k]).toEqual(old[k]);
    expect(next.updatedAt).toBe(1000);
    expect(next.handVideo).toEqual(old.handVideo);
    expect(next.favorite).toBe(true);
    expect(next.hasAudio).toBe(true);
    // replaced
    expect(next.transcription.method).toBe('piano-specialist');
    expect(next.noteLength).toBe('played');
    expect(next.autoPedal).toBe(false);
    expect(next.hasPosteriors).toBe(false);
    expect(next.basePedal).toHaveLength(8);
    expect(next.tempo.bpm).toBe(118);
    expect(next.base.every((n) => n.dur <= 0.13)).toBe(true);
    // removed: the sheet's lock and marks, the kept as-played notes
    expect('sheet' in next).toBe(false);
    expect('notesAsPlayed' in next).toBe(false);
    // every level rebuilt, unedited, with no fingering or marks
    for (const d of ['easy', 'medium', 'hard'] as const) {
      const a = next.arrangements[d];
      expect(a.edited).toBe(false);
      expect(a.marks).toBeUndefined();
      expect(a.pedalEdited).toBeUndefined();
      expect(a.notes.some((n) => n.finger)).toBe(false);
    }
    expect(next.arrangements.hard.pedal).toEqual(next.basePedal);
    expect(next.arrangements.easy.pedal).toEqual([]);
    // the levels are what the song's own options build (Easy from the notes as they ring)
    const again = generateAllArrangements(next.base, next.basePedal, next.tempo, next.duration, arrangementOptions(next));
    for (const d of ['easy', 'medium', 'hard'] as const) expect(next.arrangements[d].notes.map(({ id: _i, ...n }) => (void _i, n))).toEqual(again[d].notes.map(({ id: _i, ...n }) => (void _i, n)));
    expect(arrangementOptions(next).easyAsHeard).toBe(true);
  });

  it('back to the normal model: no note length, the automatic pedal on, posteriors again', () => {
    const old = songFromReanalysis(fullSong(), specialistResult(), 5);
    const next = songFromReanalysis(old, bpResult(), 6);
    expect(next.transcription.method).toBe('basic-pitch');
    expect('noteLength' in next).toBe(false);
    expect(next.autoPedal).toBe(true);
    expect(next.hasPosteriors).toBe(true);
    expect(next.basePedal).toEqual([]);
    expect(arrangementOptions(next)).toEqual({ handsFromScore: false, autoPedal: true });
  });

  it('a tempo set by hand is kept, and the levels are built on it', () => {
    const old = fullSong();
    const manual = { ...old.tempo, bpm: 90, beats: Array.from({ length: 16 }, (_, i) => i * (60 / 90)), source: 'manual' as const, confidence: 1 };
    const next = songFromReanalysis({ ...old, tempo: manual }, specialistResult(), 7);
    expect(next.tempo).toEqual(manual);
    const again = generateAllArrangements(next.base, next.basePedal, manual, next.duration, arrangementOptions(next));
    expect(next.arrangements.medium.notes.length).toBe(again.medium.notes.length);
  });

  it('withAnalysisOf swaps the analysis and nothing else (absent fields are removed)', () => {
    const a = fullSong();
    const b = songFromReanalysis(a, specialistResult(), 9);
    const back = withAnalysisOf({ ...b, title: 'Renamed' }, a);
    expect(back.title).toBe('Renamed');
    expect(back.sheet).toEqual(a.sheet);
    expect(back.noteLength).toBe('heard');
    expect(back.arrangements).toBe(a.arrangements);
    const fwd = withAnalysisOf(a, b);
    expect('sheet' in fwd).toBe(false);
    expect('notesAsPlayed' in fwd).toBe(false);
    expect(fwd.noteLength).toBe('played');
  });
});

describe('what "Analyze again" says it replaces', () => {
  it('names the levels with fixes (Hard first), the sheet edits, the pedal and the note length', () => {
    const lost = lostWork(fullSong());
    expect(lost).toEqual({ levels: ['hard', 'easy'], sheet: true, pedal: ['hard'], heard: true });
    expect(lossText(lost, true)).toBe(
      'This replaces the notes on every level. Your fixes on Hard and Easy, sheet edits and key/time/tempo marks, pedal changes on Hard and “As heard” note lengths will be removed. Undo history is cleared. You can go back to the old notes afterward.',
    );
    expect(lossText({ levels: ['hard', 'easy'], sheet: true, pedal: [], heard: false }, false)).toBe(
      'This replaces the notes on every level. Your fixes on Hard and Easy and sheet edits and key/time/tempo marks will be removed. You can go back to the old notes afterward.',
    );
    expect(lossText({ levels: [], sheet: false, pedal: [], heard: false }, false)).toBe('This replaces the notes on every level. You can go back to the old notes afterward.');
    expect(joinAnd(['Hard', 'Medium', 'Easy'])).toBe('Hard, Medium and Easy');
  });
});

describe('what a song was analyzed with', () => {
  const custom = { ...EXTRACTION_PRESETS.piano, onsetThreshold: 0.33 };
  const table: [string, TranscriptionInfo, ReturnType<typeof presetOfInfo>, string][] = [
    ['Basic Pitch, Piano solo', bpInfo(), 'piano', 'Piano solo · standard model'],
    ['Basic Pitch, Full song (stored before lead recovery)', bpInfo({ params: { ...EXTRACTION_PRESETS.mix, leadPass: undefined } as never }), 'mix', 'Full song'],
    ['Basic Pitch, Full song separated', bpInfo({ params: EXTRACTION_PRESETS.mix, separation: { engine: 'scnet-browser', vocals: true, ms: 1 } }), 'mix', 'Full song · vocals & drums separated'],
    ['Sensitive', bpInfo({ params: EXTRACTION_PRESETS.sensitive }), 'sensitive', 'Sensitive'],
    ['custom thresholds', bpInfo({ params: custom }), 'custom', 'Custom settings'],
    ['the piano model', specInfo(), 'piano', 'Piano solo · high-accuracy piano model'],
    [
      'the piano model with the singing and drums removed',
      specInfo({ separation: { engine: 'scnet-browser', vocals: false, pianoPart: true, singing: true, ms: 1 } }),
      'piano',
      'Piano solo · high-accuracy piano model · singing and drums removed',
    ],
    ['Basic Pitch piano part', bpInfo({ separation: { engine: 'scnet-browser', vocals: false, pianoPart: true, ms: 1 } }), 'piano', 'Piano solo · standard model · singing and drums removed'],
    [
      'Full song + piano model',
      bpInfo({ params: EXTRACTION_PRESETS.mix, separation: { engine: 'scnet-browser', vocals: true, ms: 1 }, pianoBlend: { v: 1, status: 'ok', input: 'other', leadAdded: 1, fills: 2, riffSegments: 0, octaveFixes: 0 } }),
      'mix',
      'Full song · vocals & drums separated · high-accuracy piano model',
    ],
    ['an older separated song (Demucs)', bpInfo({ params: { ...EXTRACTION_PRESETS.mix, onsetThreshold: 0.41 }, separated: true }), 'mix', 'Full song · vocals & drums separated'],
    ['unknown thresholds', bpInfo({ params: { ...EXTRACTION_PRESETS.piano, minNoteMs: 77 } }), null, 'Earlier settings'],
  ];
  for (const [name, info, preset, label] of table) {
    it(name, () => {
      expect(presetOfInfo(info, custom)).toBe(preset);
      expect(analysisLabel(info, custom)).toBe(label);
    });
  }
  it('MIDI, sheet music and the demo have no analysis', () => {
    expect(analysisLabel({ method: 'midi-file', estimated: false, warnings: [] })).toBe('');
    expect(presetOfInfo({ method: 'score-file', estimated: false, warnings: [] })).toBeNull();
  });
  it('same settings as last time', () => {
    expect(sameAsLast(bpInfo(), { presetId: 'piano', separate: false, transcriber: 'basic-pitch', pianoBlend: false })).toBe(true);
    expect(sameAsLast(bpInfo(), { presetId: 'piano', separate: false, transcriber: 'piano-specialist', pianoBlend: false })).toBe(false);
    expect(sameAsLast(bpInfo(), { presetId: 'piano', separate: true, transcriber: 'basic-pitch', pianoBlend: false })).toBe(false);
    expect(sameAsLast(specInfo(), { presetId: 'piano', separate: false, transcriber: 'piano-specialist', pianoBlend: false })).toBe(true);
    expect(sameAsLast(bpInfo({ params: { ...EXTRACTION_PRESETS.piano, minNoteMs: 77 } }), { presetId: 'piano', separate: false, transcriber: 'basic-pitch', pianoBlend: false })).toBe(false);
  });
});

describe('whether a song can be analyzed again', () => {
  const audio = fullSong();
  it('needs the stored recording', () => {
    expect(reanalyzeSupport(audio, true)).toEqual({ ok: true });
    expect(reanalyzeSupport(audio, false)).toEqual({ ok: false, kind: 'cleared', reimport: '/import' });
    expect(reanalyzeSupport({ ...audio, hasAudio: false }, false)).toEqual({ ok: false, kind: 'not-saved', reimport: '/import' });
    expect(reanalyzeSupport({ ...audio, source: { kind: 'capture' } }, false)).toEqual({ ok: false, kind: 'cleared', reimport: '/import?tab=record' });
    expect(reanalyzeSupport({ ...audio, source: { kind: 'youtube' }, hasAudio: false }, false)).toEqual({ ok: false, kind: 'not-saved', reimport: '/import?tab=computer' });
  });
  it('MIDI files and sheet music have exact notes; the demo has nothing', () => {
    expect(reanalyzeSupport({ ...audio, source: { kind: 'midi' }, hasAudio: false, transcription: { method: 'midi-file', estimated: false, warnings: [] } }, false)).toEqual({ ok: false, kind: 'exact' });
    expect(reanalyzeSupport({ ...audio, source: { kind: 'score' }, hasAudio: false, transcription: { method: 'score-file', estimated: false, warnings: [] } }, false)).toEqual({ ok: false, kind: 'exact' });
    expect(reanalyzeSupport({ ...audio, source: { kind: 'demo' }, hasAudio: false, transcription: { method: 'demo', estimated: false, warnings: [] } }, false)).toEqual({ ok: false, kind: 'demo' });
  });
});

describe('Reset {Level} to detected notes', () => {
  const imported = () => ({ ...buildSong(songInputFromResult(bpResult(), { title: 'Piece', source: { kind: 'audio' } })), id: 's' });
  it('a level as detected: nothing to reset (ids and build times do not count)', () => {
    const s = imported();
    const renumbered = { ...s, arrangements: { ...s.arrangements, hard: { ...s.arrangements.hard, generatedAt: 1, notes: s.arrangements.hard.notes.map((n) => ({ ...n, id: n.id + 1000 })) } } };
    const r = resetLevel(renumbered, 'hard');
    expect(r).toMatchObject({ changed: false, noteChanges: 0, extras: [], userEdited: false });
  });
  it('counts the notes that go back, and the fingering, markings and pedal removed', () => {
    const s = imported();
    const hard = s.arrangements.hard;
    const edited = {
      ...s,
      arrangements: {
        ...s.arrangements,
        hard: { ...hard, edited: true, notes: [...hard.notes.slice(1).map((n, i) => (i < 2 ? { ...n, midi: n.midi + 12 } : i === 3 ? { ...n, finger: 2 as const } : n))], pedalEdited: true as const },
      },
    };
    const r = resetLevel(edited, 'hard');
    // one deleted note and two moved ones go back (the fingered note is the same note)
    expect(r.noteChanges).toBe(3);
    expect(r.extras).toEqual(['fingering', 'pedal changes']);
    expect(r.changed).toBe(true);
    expect(r.userEdited).toBe(true);
    expect(r.song.arrangements.hard.edited).toBe(false);
    expect(resetToastBody(r, 'hard')).toBe('3 notes went back to the detected version. Fingering and pedal changes on this level were removed.');
    const one = resetLevel({ ...s, arrangements: { ...s.arrangements, medium: { ...s.arrangements.medium, edited: true, notes: s.arrangements.medium.notes.slice(1) } } }, 'medium');
    expect(resetToastBody(one, 'medium')).toBe('1 note went back to the detected version.');
    expect(resetToastBody({ ...one, extras: ['fingering'] , noteChanges: 0 }, 'medium')).toBe('Fingering on this level was removed.');
  });
  it('a level rebuilt from Hard but never edited: it matches the detected notes again', () => {
    const s = imported();
    const easy = { ...s.arrangements.easy, notes: s.arrangements.easy.notes.slice(2) };
    const r = resetLevel({ ...s, arrangements: { ...s.arrangements, easy } }, 'easy');
    expect(r.changed).toBe(true);
    expect(resetToastBody(r, 'easy')).toBe('Easy matches the detected notes again.');
  });
});
