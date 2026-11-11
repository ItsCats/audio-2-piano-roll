/**
 * Published transcription-accuracy figures shown on the Accuracy page.
 * Keep in sync with docs/TRANSCRIPTION.md and the benchmark in tests/e2e (npm run test:e2e).
 */
export const ACCURACY_UPDATED = '2026-11-11';

export interface BenchmarkRow {
  piece: string;
  description: string;
  notes: number;
  /** note-onset F1 (0..1): pitch exact, onset within ±50 ms */
  f1: number;
  precision: number;
  recall: number;
  /** F1 with the model's stock settings, for comparison */
  baselineF1: number;
  meanTimingErrorMs: number;
  tempoDetected: string;
  keyDetected: string;
}

export const PIANO_BENCHMARK: BenchmarkRow[] = [
  {
    piece: 'J. S. Bach — Prelude in C major, BWV 846',
    description: 'Flowing arpeggios with sustain pedal, played on a sampled concert grand with hall reverb',
    notes: 517,
    f1: 0.94,
    precision: 0.93,
    recall: 0.94,
    baselineF1: 0.77,
    meanTimingErrorMs: 0.6,
    tempoDetected: '65.9 BPM (actual 66)',
    keyDetected: 'C major ✓',
  },
  {
    piece: 'Chord & melody study',
    description: 'Block chords, bass octaves, repeated chord tones and a melody on top',
    notes: 224,
    f1: 0.88,
    precision: 0.92,
    recall: 0.84,
    baselineF1: 0.78,
    meanTimingErrorMs: 4.4,
    tempoDetected: '120 BPM (actual 120)',
    keyDetected: 'C major ✓',
  },
];

export type Rating = 1 | 2 | 3 | 4 | 5;

export interface Expectation {
  kind: string;
  examples: string;
  rating: Rating;
  /** true once backed by a measurement on real recordings; false = informed estimate */
  measured: boolean;
  summary: string;
  tips: string;
}

export const EXPECTATIONS: Expectation[] = [
  {
    kind: 'MIDI files',
    examples: 'Any .mid / .midi file',
    rating: 5,
    measured: true,
    summary: 'Exact. Notes, velocities, sustain pedal and tempo are read directly from the file — nothing is guessed.',
    tips: 'If you can find a MIDI of the piece, import it instead of audio.',
  },
  {
    kind: 'Clean solo piano',
    examples: 'Studio or close-miked piano recordings, piano covers',
    rating: 4,
    measured: false,
    summary: 'Most notes are right and timing is precise. Expect some missed repeated notes under the pedal and occasional extra notes.',
    tips: 'Use the “Piano solo” preset. Blend in the original recording to spot mistakes, then fix them in Edit mode.',
  },
  {
    kind: 'Classical piano with lots of pedal or reverb',
    examples: 'Chopin, Debussy, concert-hall recordings',
    rating: 3,
    measured: false,
    summary: 'The music is recognisable, but fast passages, soft inner voices and notes repeated while the pedal is down are often missed or merged.',
    tips: 'Try “Sensitive” if quiet notes are missing; raise “Merge ringing re-detections” if long notes break into repeats.',
  },
  {
    kind: 'Jazz piano',
    examples: 'Solo jazz piano, stride, ballads',
    rating: 3,
    measured: false,
    summary: 'Chords and melody come through; swing rhythm, dense voicings and which hand plays what are the hardest parts.',
    tips: 'Set the tempo manually if the beat grid looks off, and check the hand split in Edit mode.',
  },
  {
    kind: 'Songs with vocals, band and drums',
    examples: 'Anime openings, pop, rock, game soundtracks',
    rating: 2,
    measured: false,
    summary: 'You get a recognisable sketch — the main melody and harmony — but many notes will be missing or extra, especially in loud, dense sections.',
    tips: 'Use the “Full song” preset, and the “Isolate the piano part” option if a processing server is set up. Expect to edit.',
  },
];

export const LIMITATIONS: { title: string; body: string }[] = [
  { title: 'Sustain pedal', body: 'The pedal isn’t detected from audio. Note lengths already include the ringing, so playback sounds right, but there are no pedal markings. MIDI imports keep their pedal.' },
  { title: 'Left / right hand', body: 'Hands are assigned by a heuristic (pitch gaps and reach), not by watching a pianist. It’s a good starting point, not an engraved edition.' },
  { title: 'Dynamics', body: 'Loudness (velocity) is estimated from the audio and the model’s confidence, so it follows the music’s shape but not exact touch.' },
  { title: 'Octaves and overtones', body: 'A loud low note contains its own octave above. We filter these “ghost” notes, but real doubled octaves played softly can be removed by mistake, and vice versa.' },
  { title: 'Fast repeated notes', body: 'A key struck again while it is still ringing produces almost no new attack sound, so quick repetitions under the pedal are the most commonly missed notes.' },
  { title: 'Easy & Medium levels', body: 'Simplified arrangements are generated automatically from the transcription. Errors in the transcription carry over into them.' },
];
