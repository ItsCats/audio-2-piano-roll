// Dev-only harness used by the E2E tests to exercise the real pipeline in a browser.
import { bachPreludeDemo } from '../../src/lib/music/demo';
import { renderOffline } from '../../src/lib/audio/offlineRender';
import { WavWriter } from '../../src/lib/audio/wav';
import { DEFAULT_AUDIO_SETTINGS } from '../../src/lib/audio/types';
import { transcribeAudio, reextractNotes, redetectNotes, EXTRACTION_PRESETS, type TranscriptionResult } from '../../src/lib/transcription/pipeline';
import type { ExtractionParams } from '../../src/lib/music/types';
import { generateAllArrangements } from '../../src/lib/music/difficulty';
import type { Note } from '../../src/lib/music/types';
import { newNoteId } from '../../src/lib/music/cleanup';
import { decodeToRate, mixToMono } from '../../src/lib/transcription/decode';
import type { SeparationResult } from '../../src/lib/separation';

function scoreNotes(ref: Note[], est: Note[], tol = 0.05) {
  const used = new Set<number>();
  let tp = 0;
  const offsets: number[] = [];
  const sortedEst = [...est].sort((a, b) => a.start - b.start);
  for (const r of ref) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < sortedEst.length; i++) {
      const e = sortedEst[i];
      if (used.has(i) || e.midi !== r.midi) continue;
      const d = Math.abs(e.start - r.start);
      if (d <= tol && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    if (best >= 0) {
      used.add(best);
      tp++;
      offsets.push(sortedEst[best].start - r.start);
    }
  }
  const precision = est.length ? tp / est.length : 0;
  const recall = ref.length ? tp / ref.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const meanOffset = offsets.reduce((s, v) => s + v, 0) / (offsets.length || 1);
  // drift: offset in the first vs last third
  const third = Math.floor(offsets.length / 3);
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  return {
    tp,
    ref: ref.length,
    est: est.length,
    precision: +precision.toFixed(3),
    recall: +recall.toFixed(3),
    f1: +f1.toFixed(3),
    meanOffsetMs: +(meanOffset * 1000).toFixed(1),
    earlyOffsetMs: +(avg(offsets.slice(0, third)) * 1000).toFixed(1),
    lateOffsetMs: +(avg(offsets.slice(-third)) * 1000).toFixed(1),
  };
}

/** A second test piece with block chords, octaves, repeated notes and a melody. */
function chordPiece(): { notes: Note[]; duration: number } {
  const notes: Note[] = [];
  const beat = 0.5;
  const prog = [
    [48, 55, 64, 67, 72], [45, 52, 60, 64, 69], [41, 48, 57, 60, 65], [43, 50, 59, 62, 67],
  ];
  const melody = [76, 74, 72, 74, 76, 76, 76, 74, 74, 74, 76, 79, 79, 77, 76, 74];
  let t = 0.3;
  for (let rep = 0; rep < 4; rep++) {
    prog.forEach((chord, ci) => {
      const t0 = t + (rep * 4 + ci) * 4 * beat;
      notes.push({ id: newNoteId(), midi: chord[0], start: t0, dur: 4 * beat - 0.05, vel: 0.6, hand: 'L' });
      notes.push({ id: newNoteId(), midi: chord[0] - 12, start: t0, dur: 4 * beat - 0.05, vel: 0.6, hand: 'L' });
      for (let b = 0; b < 4; b++) {
        for (const m of chord.slice(1, 3)) notes.push({ id: newNoteId(), midi: m, start: t0 + b * beat, dur: beat * 0.8, vel: 0.45, hand: 'L' });
        const mel = melody[(ci * 4 + b) % melody.length];
        notes.push({ id: newNoteId(), midi: mel, start: t0 + b * beat, dur: beat * 0.9, vel: 0.75, hand: 'R' });
      }
    });
  }
  return { notes, duration: t + 16 * 4 * beat + 1 };
}

async function runAccuracy(piece: 'bach' | 'chords', preset: keyof typeof EXTRACTION_PRESETS = 'piano', reverb = true) {
  const src = piece === 'bach' ? bachPreludeDemo() : { ...chordPiece(), pedal: [] };
  const settings = { ...DEFAULT_AUDIO_SETTINGS, reverbType: reverb ? 'hall' as const : 'off' as const };
  const t0 = performance.now();
  const audio = await renderOffline({ notes: src.notes, pedal: src.pedal, settings, start: 0, end: src.duration, rate: 1, sampleRate: 44100 });
  const renderMs = performance.now() - t0;
  const wav = new WavWriter(44100);
  wav.append(audio);
  const blob = wav.finish();
  const stages: string[] = [];
  const res = await transcribeAudio(blob, EXTRACTION_PRESETS[preset], (e) => {
    const s = `${e.stage}`;
    if (stages[stages.length - 1] !== s) stages.push(s);
  });
  const arr = generateAllArrangements(res.notes, [], res.tempo, res.duration);
  return {
    piece,
    preset,
    renderMs: Math.round(renderMs),
    transcribeMs: res.info.processingMs,
    backend: res.info.backend,
    stages,
    score: scoreNotes(src.notes, res.notes),
    tempo: { bpm: res.tempo.bpm, conf: +res.tempo.confidence.toFixed(2), meter: res.tempo.beatsPerBar },
    key: res.key?.name,
    handsAgreement: handAgreement(src.notes, res.notes),
    counts: { easy: arr.easy.notes.length, medium: arr.medium.notes.length, hard: arr.hard.notes.length },
    warnings: res.info.warnings,
  };
}

function handAgreement(ref: Note[], est: Note[]) {
  let agree = 0;
  let total = 0;
  for (const e of est) {
    const r = ref.find((x) => x.midi === e.midi && Math.abs(x.start - e.start) < 0.05);
    if (!r) continue;
    total++;
    if (r.hand === e.hand) agree++;
  }
  return +(agree / (total || 1)).toFixed(3);
}

function diagnose(ref: Note[], est: Note[], tol = 0.05) {
  const cats: Record<string, number> = {};
  const examples: Record<string, string[]> = {};
  for (const e of est) {
    const exact = ref.some((r) => r.midi === e.midi && Math.abs(r.start - e.start) <= tol);
    if (exact) continue;
    const near = ref.filter((r) => Math.abs(r.start - e.start) <= 0.08);
    const sounding = ref.filter((r) => r.start - 0.05 <= e.start && r.start + r.dur + 0.3 >= e.start);
    let cat = 'other';
    if (sounding.some((r) => r.midi === e.midi)) cat = 'same-pitch-fragment';
    else if (near.some((r) => [12, 19, 24, 28, 31].includes(e.midi - r.midi))) cat = 'harmonic-above';
    else if (near.some((r) => [12, 19, 24].includes(r.midi - e.midi))) cat = 'subharmonic';
    else if (e.midi >= 96 || e.midi < 28) cat = 'extreme-range';
    else if (near.some((r) => Math.abs(e.midi - r.midi) === 1)) cat = 'semitone-neighbour';
    else if (ref.some((r) => r.midi === e.midi && Math.abs(r.start - e.start) <= 0.12)) cat = 'late-onset';
    cats[cat] = (cats[cat] ?? 0) + 1;
    (examples[cat] ??= []).length < 4 && examples[cat].push(`${e.midi}@${e.start.toFixed(2)} d=${e.dur.toFixed(2)} v=${e.vel.toFixed(2)}`);
  }
  return { cats, examples };
}

async function runDiagnose(piece: 'bach' | 'chords', preset: keyof typeof EXTRACTION_PRESETS = 'piano', reverb = true) {
  const src = piece === 'bach' ? bachPreludeDemo() : { ...chordPiece(), pedal: [] };
  const settings = { ...DEFAULT_AUDIO_SETTINGS, reverbType: reverb ? 'hall' as const : 'off' as const };
  const audio = await renderOffline({ notes: src.notes, pedal: src.pedal, settings, start: 0, end: src.duration, rate: 1, sampleRate: 44100 });
  const wav = new WavWriter(44100);
  wav.append(audio);
  const res = await transcribeAudio(wav.finish(), EXTRACTION_PRESETS[preset], () => {});
  return { score: scoreNotes(src.notes, res.notes), ...diagnose(src.notes, res.notes) };
}

const cache = new Map<string, { res: TranscriptionResult; ref: Note[] }>();
async function runTune(piece: 'bach' | 'chords', grid: Partial<ExtractionParams>[], reverb = true) {
  const key = `${piece}:${reverb}`;
  if (!cache.has(key)) {
    const src = piece === 'bach' ? bachPreludeDemo() : { ...chordPiece(), pedal: [] };
    const settings = { ...DEFAULT_AUDIO_SETTINGS, reverbType: reverb ? 'hall' as const : 'off' as const };
    const audio = await renderOffline({ notes: src.notes, pedal: src.pedal, settings, start: 0, end: src.duration, rate: 1, sampleRate: 44100 });
    const wav = new WavWriter(44100);
    wav.append(audio);
    const res = await transcribeAudio(wav.finish(), EXTRACTION_PRESETS.piano, () => {});
    cache.set(key, { res, ref: src.notes });
  }
  const { res, ref } = cache.get(key)!;
  const out = [];
  for (const g of grid) {
    const params = { ...EXTRACTION_PRESETS.piano, ...g };
    const notes = await reextractNotes(res.posteriors, params, res.duration);
    const d = diagnose(ref, notes);
    const missed: Record<string, number> = {};
    for (const r of ref) {
      if (notes.some((e) => e.midi === r.midi && Math.abs(e.start - r.start) <= 0.05)) continue;
      let cat = 'other';
      if (notes.some((e) => e.midi === r.midi && Math.abs(e.start - r.start) <= 0.12)) cat = 'timing>50ms';
      else if (ref.some((x) => x !== r && x.midi === r.midi && x.start < r.start && x.start + x.dur > r.start - 0.12)) cat = 'repeat-of-ringing';
      else if (ref.some((x) => Math.abs(x.start - r.start) < 0.05 && [12, 19, 24].includes(r.midi - x.midi))) cat = 'octave/12th-above-other';
      else if (ref.some((x) => Math.abs(x.start - r.start) < 0.05 && [12, 19, 24].includes(x.midi - r.midi))) cat = 'octave-below-other';
      missed[cat] = (missed[cat] ?? 0) + 1;
      if (cat === 'other') {
        const near = notes.filter((e) => Math.abs(e.start - r.start) < 0.15).map((e) => `${e.midi}@${e.start.toFixed(2)}`);
        (missed as Record<string, unknown>)['ex'] = [...(((missed as Record<string, unknown>)['ex'] as string[]) ?? []), `${r.midi}@${r.start.toFixed(2)}[${near.join(',')}]`].slice(0, 12);
      }
    }
    out.push({ g, ...scoreNotes(ref, notes), cats: d.cats, missed });
  }
  return out;
}

/**
 * TranscribeOptions.separation must not be consumed: the same in-page result is passed to two
 * calls (the accompaniment = the rendered piece, the "vocals" = the same audio at half level).
 */
async function runSeparationReuse() {
  const src = bachPreludeDemo();
  const end = Math.min(src.duration, 12);
  const audio = await renderOffline({ notes: src.notes.filter((n) => n.start < end), pedal: [], settings: DEFAULT_AUDIO_SETTINGS, start: 0, end, rate: 1, sampleRate: 44100 });
  const wav = new WavWriter(44100);
  wav.append(audio);
  const blob = wav.finish();
  const mono = mixToMono(await decodeToRate(blob, 22050));
  const separation: SeparationResult = {
    sampleRate: 22050,
    accomp: mono,
    vocals: mono.map((v) => v * 0.5),
    vocalPresence: { activeFraction: 1, relDb: -6, present: true },
    engine: 'scnet-browser',
    ms: 1,
  };
  const before = { accomp: separation.accomp.length, vocals: separation.vocals.length, v0: separation.vocals.find((v) => v !== 0) };
  const a = await transcribeAudio(blob, EXTRACTION_PRESETS.mix, () => {}, undefined, { separation });
  const b = await transcribeAudio(blob, EXTRACTION_PRESETS.mix, () => {}, undefined, { separation });
  // Studio "Re-detect" keeps the sung line; its beats must come from the accompaniment alone, as on
  // import, so the kept melody notes must not change the tempo
  const melody = a.notes.filter((n) => n.role === 'melody');
  const withMelody = await redetectNotes(a.posteriors, EXTRACTION_PRESETS.mix, a.duration, { melody });
  const without = await redetectNotes(a.posteriors, EXTRACTION_PRESETS.mix, a.duration);
  return {
    intact: separation.accomp.length === before.accomp && separation.vocals.length === before.vocals && separation.vocals.find((v) => v !== 0) === before.v0,
    notes: [a.notes.length, b.notes.length],
    melody: [a.notes.filter((n) => n.role === 'melody').length, b.notes.filter((n) => n.role === 'melody').length],
    redetect: {
      keptMelody: withMelody.notes.filter((n) => n.role === 'melody').length,
      sameTempoWithAndWithoutMelody:
        withMelody.tempo.bpm === without.tempo.bpm && withMelody.tempo.confidence === without.tempo.confidence && withMelody.tempo.beats.join() === without.tempo.beats.join(),
    },
  };
}

Object.assign(window, { runAccuracy, scoreNotes, runDiagnose, runTune, runSeparationReuse });
document.getElementById('log')!.textContent = 'ready';

async function sampleOnsets() {
  const { SampleLibrary } = await import('../../src/lib/audio/sampleLibrary');
  const lib = await SampleLibrary.load('salamander');
  const out: Record<string, unknown> = {};
  for (const m of [21, 48, 60, 69, 84, 105]) {
    const p = lib.pick(m, 69)!;
    const d = p.sample.buffer.getChannelData(0);
    let first = -1;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.0006) { first = i; break; }
    let firstTiny = -1;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 1e-6) { firstTiny = i; break; }
    out[m] = { offsetMs: +(p.sample.offset * 1000).toFixed(2), firstAboveThrMs: +((first / p.sample.buffer.sampleRate) * 1000).toFixed(2), firstNonZeroMs: +((firstTiny / p.sample.buffer.sampleRate) * 1000).toFixed(2), sr: p.sample.buffer.sampleRate };
  }
  const buf = await renderOffline({ notes: [{ id: 1, midi: 60, start: 0.5, dur: 1, vel: 0.6, hand: 'R' }], pedal: [], settings: { ...DEFAULT_AUDIO_SETTINGS, reverbType: 'off' }, start: 0, end: 2, rate: 1, sampleRate: 48000 });
  const d = buf.getChannelData(0);
  let on = -1;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 1e-4) { on = i; break; }
  out.renderedOnsetMs = +((on / 48000) * 1000).toFixed(2);
  return out;
}
Object.assign(window, { sampleOnsets });
