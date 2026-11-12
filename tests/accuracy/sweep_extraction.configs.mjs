/**
 * Track F result: the recommended 'piano' / 'sensitive' detection values next to the current
 * presets, for sweep_extraction.mjs and sweep_extraction.e2e.mjs (--configs this file).
 *
 * Tuned jointly on MAESTRO Debussy / Bach BWV 850 / Mozart K280 / Chopin Nocturne 15-1 (test
 * split) + Chopin Ballade 1 (train split), Liszt Waldesrauschen held out, subject to the synthetic
 * e2e gate (Bach >= 0.93, chords >= 0.87) for 'piano'. `latency` = the proposed ONSET_LATENCY.
 */
export const REGISTER = { lowMidi: 48, lowFrame: 0.5, lowOnset: 0.6, highMidi: 76, highFrame: 0.3, highMinFrames: 0.4 };
export const PIANO = { onsetThreshold: 0.55, frameThreshold: 0.4, minNoteMs: 60, continuationOnset: 0.7, register: REGISTER };
export const SENSITIVE = { onsetThreshold: 0.55, frameThreshold: 0.25, minNoteMs: 50, continuationOnset: 0.5, suppressHarmonics: true, register: REGISTER };
export const ONSET_LATENCY = 0;

// `register` is an ExtractionParams field once pipeline.ts maps it in toWorkerOptions(); until then
// it is passed to extractNotes directly as an extraction option.
const split = ({ register, ...params }) => ({ params, extraction: { register } });
export default [
  { name: 'piano (current)', preset: 'piano' },
  { name: 'piano (recommended)', preset: 'piano', ...split(PIANO), latency: ONSET_LATENCY },
  { name: 'sensitive (current)', preset: 'sensitive' },
  { name: 'sensitive (recommended)', preset: 'sensitive', ...split(SENSITIVE), latency: ONSET_LATENCY },
];
