/**
 * Published transcription-accuracy figures shown on the Accuracy page (/accuracy).
 *
 * Every number comes from the round-2 measurement of the final app (2026-11-11): the real
 * in-browser pipeline (tests/accuracy/transcribe.mjs, full recordings, "Full song" songs with
 * --separate --coi) scored by tests/accuracy/evaluate.py, melody_eval.py and inst_eval.py
 * (see tests/accuracy/README.md). "Before" = the baseline measurement of the earlier version
 * on the same recordings with the same scripts. Keep in sync with docs/TRANSCRIPTION.md.
 * Copyrighted test songs are described, never named or shared.
 */
export const ACCURACY_UPDATED = '2026-11-11';

export interface GlanceCard {
  icon: 'piano' | 'mic' | 'bass' | 'timer';
  value: string;
  label: string;
  sub: string;
}

export const AT_A_GLANCE: GlanceCard[] = [
  {
    icon: 'piano',
    value: '80%',
    label: 'Notes right on concert piano',
    sub: '6 recorded performances with an exact answer key, “Piano solo” preset (62–92% per piece; was 78%).',
  },
  {
    icon: 'mic',
    value: '50%',
    label: 'Easy right hand plays the singer’s note',
    sub: 'Share of sung moments, 5 full songs with “Separate vocals & drums”. Was 19%; best possible ≈ 62%.',
  },
  {
    icon: 'bass',
    value: '71%',
    label: 'Easy left hand on the bass note',
    sub: 'Same 5 songs (was 52%). On the instrumental band track: 49% (was 30%).',
  },
  {
    icon: 'timer',
    value: '7 s · 1 min',
    label: 'Per minute of audio',
    sub: 'Without / with separation, in the browser on a 4-core CPU. Separation needs about 2 GB of memory.',
  },
];

export interface MaestroRow {
  piece: string;
  detail: string;
  notes: number;
  /** note F1 (pitch exact, onset ±50 ms) with the "Piano solo" preset */
  f1: number;
  precision: number;
  recall: number;
  f1Sensitive: number;
  /** "Piano solo" F1 of the earlier version */
  before: number;
}

/** MAESTRO v3 performances (exact Disklavier MIDI), full length. */
export const MAESTRO_ROWS: MaestroRow[] = [
  { piece: 'J. S. Bach — Prelude & Fugue in D major, BWV 850', detail: '2:56 · clear counterpoint · used for tuning', notes: 1498, f1: 0.92, precision: 0.94, recall: 0.91, f1Sensitive: 0.9, before: 0.91 },
  { piece: 'Debussy — Des pas sur la neige', detail: '4:12 · slow and very soft · used for tuning', notes: 366, f1: 0.9, precision: 0.9, recall: 0.89, f1Sensitive: 0.86, before: 0.89 },
  { piece: 'Mozart — Sonata in F major, K. 280, 1st mvt.', detail: '3:14 · fast scales and Alberti bass · used for tuning', notes: 1832, f1: 0.88, precision: 0.94, recall: 0.82, f1Sensitive: 0.88, before: 0.86 },
  { piece: 'Chopin — Nocturne in F major, Op. 15 No. 1', detail: '4:03 · stormy fast middle section · used for tuning', notes: 1780, f1: 0.75, precision: 0.88, recall: 0.66, f1Sensitive: 0.78, before: 0.75 },
  { piece: 'Chopin — Ballade No. 1 in G minor, Op. 23', detail: '8:32 · virtuoso, dense, wide range · used for tuning', notes: 5112, f1: 0.75, precision: 0.92, recall: 0.63, f1Sensitive: 0.78, before: 0.71 },
  { piece: 'Liszt — Waldesrauschen (Concert Étude No. 1)', detail: '3:41 · rapid soft figuration · NOT used for tuning (the fairest test)', notes: 3297, f1: 0.62, precision: 0.94, recall: 0.46, f1Sensitive: 0.71, before: 0.57 },
];

export const MAESTRO_CAVEATS: { title: string; body: string }[] = [
  {
    title: 'What is found is usually right',
    body: 'When the app writes a note it is a real note 88–94% of the time. The misses are the problem: fast, soft passages lose many notes (Liszt: fewer than half found with “Piano solo”, 58% with “Sensitive”).',
  },
  {
    title: 'Fast notes',
    body: 'Notes in quick runs (10 or more notes a second) are found 57% of the time, against 78% for the rest (“Sensitive”: 68% vs 84%).',
  },
  {
    title: 'Very high and very low notes',
    body: 'The top octave (C6 and up) is now found 39% of the time (was 21%), 52% with “Sensitive”. The lowest notes (below C2) are rare in these pieces and mostly missed (15%).',
  },
  {
    title: 'Timing and note lengths',
    body: 'Correctly found notes start within 5 ms of the real key press (median; 90% within 12 ms), with no drift over a piece. Note lengths are much less accurate: the sustain pedal is not detected, and only about 15–45% of notes also end at the right time (it varies by piece).',
  },
  {
    title: 'Tuned on these pieces',
    body: 'The “Piano solo” and “Sensitive” settings were tuned on five of these six pieces, so their scores are a little optimistic. Liszt was kept aside for testing and improved too (57% → 62%, “Sensitive” 67% → 71%).',
  },
  {
    title: 'Easy level',
    body: 'Measured against the top voice of the answer key, the Easy right hand plays the tune’s note (any octave) in 45% of the moments the tune sounds (was 39%), and jumps more than an octave in only 1.4% of its steps (was 3.5%). Counted note by note, the notes it picks match the tune a little more often too (58% → 63%).',
  },
];

export interface RecordingRow {
  piece: string;
  detail: string;
  length: string;
  /** note F1 agreement with the piano-specialist model, "Piano solo" */
  agreement: number;
  agreementSensitive: number;
  before: number;
}

/** Solo piano recordings without an answer key, compared with the ByteDance piano transcriber. */
export const OTHER_PIANO_ROWS: RecordingRow[] = [
  { piece: 'Chopin — Polonaise in A-flat major, Op. 53 (“Heroic”)', detail: 'Solo piano · loud chords and octaves, fast runs', length: '7:17', agreement: 0.64, agreementSensitive: 0.69, before: 0.6 },
  { piece: 'Chopin — Ballade No. 1, Op. 23', detail: 'Solo piano · a different, commercial recording', length: '10:13', agreement: 0.72, agreementSensitive: 0.77, before: 0.68 },
  { piece: 'Debussy — Clair de lune', detail: 'Solo piano · soft, pedalled, rolled chords', length: '5:13', agreement: 0.65, agreementSensitive: 0.67, before: 0.61 },
  { piece: 'Chopin — Nocturne in F minor, Op. 55 No. 1', detail: 'Solo piano · Musopen recording (public domain)', length: '5:17', agreement: 0.61, agreementSensitive: 0.64, before: 0.58 },
  { piece: 'Jazz piano cover of a pop song', detail: 'Solo piano · swing, dense voicings', length: '1:57', agreement: 0.56, agreementSensitive: 0.63, before: 0.5 },
];

export interface SongRow {
  song: string;
  detail: string;
  /** octave-tolerant share of sung moments where the RH plays the sung note */
  easy: number;
  easyBefore: number;
  medium: number;
  mediumBefore: number;
  /** the singer's own pitch written as notes, scored the same way */
  best: number;
  /** Easy LH lowest note = the bass part's note (any octave), share of bass moments */
  bass: number;
  bassBefore: number;
}

export const SONG_ROWS: SongRow[] = [
  { song: 'Song 1', detail: 'Pop, sung chorus and rapped verses · 3:47', easy: 0.51, easyBefore: 0.25, medium: 0.58, mediumBefore: 0.3, best: 0.68, bass: 0.68, bassBefore: 0.49 },
  { song: 'Song 2', detail: 'Synth-pop, solo voice · 4:07', easy: 0.61, easyBefore: 0.22, medium: 0.62, mediumBefore: 0.25, best: 0.69, bass: 0.83, bassBefore: 0.57 },
  { song: 'Song 3', detail: 'Electronic, little singing · 1:30', easy: 0.48, easyBefore: 0.16, medium: 0.46, mediumBefore: 0.17, best: 0.58, bass: 0.78, bassBefore: 0.67 },
  { song: 'Song 4', detail: 'Funk band · 1:30', easy: 0.58, easyBefore: 0.24, medium: 0.61, mediumBefore: 0.32, best: 0.62, bass: 0.65, bassBefore: 0.48 },
  { song: 'Song 5', detail: 'Dense, loud band mix — the hardest · 4:47', easy: 0.34, easyBefore: 0.11, medium: 0.35, mediumBefore: 0.11, best: 0.56, bass: 0.62, bassBefore: 0.39 },
];

export const SONG_SUMMARY = {
  intro:
    'Five commercial songs with a singer, band and drums (we can’t share the audio). For every moment the singer sings, we check whether the Easy right hand plays the same note — in any octave, because Easy and Medium move the tune into a comfortable right-hand octave on purpose. “Best possible” is the singer’s own pitch written out as notes and scored the same way: vibrato, slides and very short notes can’t be written as piano notes, so 100% is out of reach.',
  notes: [
    'On average the Easy right hand now follows the singer 50% of the sung moments (was 19%; best possible 62%), Medium 53% (was 23%). The left hand plays the bass part’s note 71% of the time (was 52%).',
    'A second, independent pitch tracker (pYIN) agrees on the direction: on clearly sung moments the Easy right hand matches the singer 70% of the time, against 30% before.',
    'Fair warning: the singer’s pitch was traced by AI tools (Demucs to separate the voice, CREPE to trace it), not written by hand — Piano2Vision itself uses neither. The melody settings were tuned on these same five songs, so expect somewhat lower results on other songs.',
  ],
};

export interface CompareRow {
  what: string;
  before: string;
  after: string;
  note?: string;
}

export const INSTRUMENTAL = {
  title: 'Instrumental band track (no singer)',
  intro:
    'An anime soundtrack theme (about 3 minutes: bass, drums, piano and lead instruments, nobody singing). Separation correctly finds no vocals, so the Easy right hand plays the instruments’ tune — now one smooth lead line instead of hopping between the piano’s chord tops and the lead instrument. There is no written answer key for this track: the “tune” here is an estimate, the pitch of the lead instruments traced by an AI pitch tracker (pYIN) on a track separated with Demucs. Read these numbers as a rough guide.',
  rows: [
    { what: 'Easy right hand plays the lead tune’s note (any octave)', before: '34%', after: '40%', note: 'Best possible from the notes the app hears: 50%. On clearly audible lead moments: 42% → 51%.' },
    { what: 'Easy right hand steps that jump more than an octave', before: '8.4%', after: '0.8%' },
    { what: 'Easy left hand on the bass note', before: '30%', after: '49%' },
    { what: 'Drum hits turned into Easy left-hand notes', before: '2.4/min', after: '6.8/min', note: 'More than before: the left hand now follows the lowest notes closely and some of them are drum hits. A drum filter exists but stays off because it lowered bass accuracy.' },
  ] as CompareRow[],
  notes: [
    'Most of the gain comes from the smoother line held on the beat. Counted note by note (ignoring how long notes are held), the notes chosen are about as often right as before (58% → 59%).',
    'In the instrumental breaks of the sung songs, where the right hand also switches to the instruments’ tune, we could not show an improvement — those breaks are short and the estimated tune is unreliable there.',
  ],
};

/** The same (final) app with and without separation, "Full song" preset. */
export const SEPARATION_EFFECT: CompareRow[] = [
  { what: 'Easy right hand plays the singer’s note', before: '24%', after: '50%', note: '5 sung songs; best possible 62%' },
  { what: 'Medium right hand plays the singer’s note', before: '23%', after: '53%' },
  { what: 'Independent check (pYIN pitch tracker), Easy', before: '37%', after: '70%', note: 'clearly sung moments only' },
  { what: 'Easy left hand on the bass note', before: '62%', after: '68%', note: '6 band songs' },
  { what: 'Full transcription’s lowest note on the bass note (Hard)', before: '67%', after: '79%', note: '6 band songs' },
  { what: 'Drum hits mistaken for low notes (full transcription)', before: '15/min', after: '13/min', note: 'About the same: up on 3 songs, down on 3' },
  { what: 'Time per minute of audio', before: '7 s', after: '≈ 1 min' },
  { what: 'Peak memory of the browser tab', before: '0.4–0.6 GB', after: '1.9–2.2 GB' },
];

export const PLAYABILITY: CompareRow[] = [
  { what: 'Medium: moments where one hand must stretch more than an octave', before: '4–10%', after: '0%', note: 'Widest stretch 28–30 → 12 semitones. Out-of-reach notes move to the other hand or the least important are dropped.' },
  { what: 'Hard: stretches wider than 14 semitones, solo piano (left hand)', before: '12.5%', after: '7.7%', note: 'Hard keeps every note and only moves notes to the other hand when it is free, so some stretches remain.' },
  { what: 'Hard: the same, band songs (left / right hand)', before: '15% / 6%', after: '12% / 10%', note: 'The right hand now also carries the sung melody on top, so it has more to reach.' },
  { what: 'Long notes chopped into quick repeats of the same key (Hard, band songs)', before: '20%', after: '16%', note: 'Share of notes that restart the same key right after it ends. Many of these are real repeated notes.' },
  { what: 'The same, solo piano / Medium band songs', before: '14% / 11%', after: '13% / 11%', note: 'About unchanged.' },
];

export const SPEED_ROWS: CompareRow[] = [
  { what: 'Full song, total time per minute of audio', before: '7 s', after: '≈ 1 min', note: '6 band songs: 0.11–0.12× / 0.9–1.07× the song’s length' },
  { what: '…of which separating vocals & drums', before: '—', after: '≈ 47 s', note: '3 processor threads (the app page is cross-origin isolated)' },
  { what: 'With one thread only (browsers without cross-origin isolation)', before: '7 s', after: '≈ 2 min 15 s', note: 'measured on a 1.5-minute song' },
  { what: 'Piano solo / Sensitive, per minute of audio', before: '7 s', after: '—', note: 'no separation for piano' },
  { what: 'Peak memory of the browser tab', before: '0.4–0.9 GB', after: '1.9–2.2 GB', note: 'Separation is off by default on phones and skipped for recordings over 10 minutes (20 minutes on devices with 8 GB or more)' },
];

export const SYNTHETIC_BENCHMARK =
  'Pieces with known notes, played through the app’s own sampled grand piano with hall reverb and transcribed in the browser on every test run: Bach’s Prelude in C (BWV 846) 94% and a chord & melody study 88% notes right, average timing error 8–12 ms (on the real concert recordings above, the median is under 5 ms). These are best-case conditions — real recordings score lower, as shown above.';

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
    examples: 'Studio or close-miked piano, steady tempo',
    rating: 4,
    measured: true,
    summary: '88–92% of notes right on clear pieces (Bach, Mozart, Debussy) with very precise timing. Some repeated notes under the pedal are missed.',
    tips: 'Use the “Piano solo” preset. Blend in the original recording to spot mistakes, then fix them in Edit mode.',
  },
  {
    kind: 'Virtuoso or heavily pedalled piano',
    examples: 'Chopin, Liszt, Debussy, concert-hall recordings',
    rating: 3,
    measured: true,
    summary: '62–78% of notes right on concert performances: fast runs, soft inner voices and the top octave are often missed, but what is written is usually right.',
    tips: 'Try “Sensitive” — it finds more notes in fast or soft music (Liszt 62% → 71%).',
  },
  {
    kind: 'Jazz piano',
    examples: 'Solo jazz piano, covers, ballads',
    rating: 3,
    measured: true,
    summary: 'Chords and melody come through; swing rhythm, dense voicings and which hand plays what are the hardest parts (one recording, compared with a second AI model: 56–63% agreement).',
    tips: 'Try “Sensitive”, set the tempo manually if the beat grid looks off, and check the hand split in Edit mode.',
  },
  {
    kind: 'Songs with a singer, band and drums',
    examples: 'Anime openings, pop, rock, game soundtracks',
    rating: 3,
    measured: true,
    summary: 'With “Separate vocals & drums” the Easy right hand plays the singer’s tune about half of the sung time (best possible ≈ 62%), over a bass line that is right about 70% of the time. The rest of the accompaniment is a sketch.',
    tips: 'Use “Full song” and keep “Separate vocals & drums” on (it takes about a minute per minute of audio). Expect to edit.',
  },
  {
    kind: 'Instrumental band music',
    examples: 'Soundtracks, instrumentals, game music',
    rating: 2,
    measured: true,
    summary: 'The right hand follows one smooth lead line; it matches the lead tune about 40% of the time on our test track (an estimate). Busy arrangements become a simplified sketch.',
    tips: 'Use “Full song”. Check the right hand against the recording and move notes where it picked the wrong instrument.',
  },
];

export const LIMITATIONS: { title: string; body: string }[] = [
  { title: 'Rap and spoken parts', body: 'Rap has no steady pitch, so there is no tune to follow. The right hand may play scattered notes there, or switch to the instruments’ tune where the app recognises the section as spoken.' },
  { title: 'Backing vocals and harmonies', body: 'When several voices sing at once, or an instrument doubles the voice, the right hand can follow the wrong one. The worst song in our tests (a dense, loud mix) reached 34% against a best possible 56%.' },
  { title: 'Fast passages', body: 'Quick runs lose more notes than slow music (57% found vs 78%). “Sensitive” helps (68%) at the cost of a few more wrong notes.' },
  { title: 'Very high and very low notes', body: 'The top octave is found less often (39%; 52% with “Sensitive”) and the lowest notes below C2 are mostly missed. On band songs, drum hits are sometimes written as low notes.' },
  { title: 'Note lengths and the pedal', body: 'Start times are precise, end times are not: the sustain pedal isn’t detected and only 15–45% of notes end at the right moment. Playback sounds right because note lengths include the ringing. MIDI imports keep their pedal.' },
  { title: 'Left / right hand', body: 'Hands are assigned by rules (pitch gaps and reach), not by watching a pianist. Medium never asks one hand to stretch more than an octave; Hard keeps every note, so a few wide stretches remain.' },
  { title: 'Octaves and overtones', body: 'A loud low note contains its own octave above. We filter these “ghost” notes, but real doubled octaves played softly can be removed by mistake, and vice versa.' },
  { title: 'Long songs and phones', body: 'Separating vocals & drums needs about 2 GB of memory and roughly a minute per minute of audio, so it is off by default on phones and skipped for recordings over 10 minutes (20 on devices with 8 GB or more); the right hand then does not follow the singer.' },
];

export const METHOD_NOTES: string[] = [
  'Every number comes from the real app running in a browser (Chromium, WebAssembly, no GPU) on the complete recordings — not excerpts — with the preset the import page suggests. “Before” is the earlier version measured the same way on the same recordings.',
  'Notes right (F1): a note counts when its pitch is exact and it starts within 50 ms of the real one — the standard measure in music-transcription research. F1 combines how many real notes were found with how many written notes were real.',
  '“Follows the singer / the tune”: 100 times a second we compare the highest right-hand note with the reference pitch and count a match when the note name is the same in any octave (the moments the right hand is silent count as misses).',
  'Only the MAESTRO piano pieces have an exact answer key. Everything else is compared with AI-made references — a piano-specialist transcriber, and pitch tracking of vocal, bass and lead tracks separated with Demucs. They are second opinions, not the truth, and we say so wherever they are used.',
  'Some settings were tuned on the same recordings (the piano presets on five MAESTRO pieces, the melody on the five songs), which flatters those numbers a little; the held-out Liszt étude and the other piano recordings are the fairer tests.',
  'Times come from a shared 4-core virtual machine; your device may be faster or slower.',
];

export interface Dataset {
  name: string;
  use: string;
  license: string;
  url?: string;
}

/** Matches the "Used to measure accuracy" group on the Credits page (src/lib/credits.ts). */
export const DATASETS: Dataset[] = [
  { name: 'MAESTRO v3 (Google Magenta)', use: '6 concert performances with the exact keys pressed — the answer key for solo piano', license: 'CC BY-NC-SA 4.0', url: 'https://magenta.tensorflow.org/datasets/maestro' },
  { name: 'Musopen', use: 'Recording of Chopin’s Nocturne Op. 55 No. 1', license: 'Public domain (CC0)', url: 'https://musopen.org' },
  { name: 'High-resolution Piano Transcription (ByteDance)', use: 'Piano-specialist model: second opinion for piano recordings without an answer key', license: 'MIT (code); CC BY 4.0 (weights)', url: 'https://github.com/bytedance/piano_transcription' },
  { name: 'Demucs (Meta AI)', use: 'Separated vocal, bass, drum and lead tracks for the references (not used by the app)', license: 'MIT (code); weights for research use', url: 'https://github.com/facebookresearch/demucs' },
  { name: 'CREPE / torchcrepe', use: 'Pitch of the singer and the bass on those tracks', license: 'MIT', url: 'https://github.com/maxrmorrison/torchcrepe' },
  { name: 'librosa (pYIN) & mir_eval', use: 'Independent second pitch tracker; standard accuracy metrics', license: 'ISC; MIT', url: 'https://github.com/mir-evaluation/mir_eval' },
  { name: 'Test songs and recordings', use: '5 songs with a singer, 1 instrumental soundtrack track, 4 commercial piano recordings — used privately for measuring only, never copied into the app or shared', license: 'Copyrighted (not distributed)' },
];
