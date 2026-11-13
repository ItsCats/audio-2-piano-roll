/**
 * Published transcription-accuracy figures shown on the Accuracy page (/accuracy).
 *
 * Every number comes from the round-2 measurement of the final app (2026-11-11): the real
 * in-browser pipeline (tests/accuracy/transcribe.mjs, full recordings, "Full song" songs with
 * --separate --coi) scored by tests/accuracy/evaluate.py, melody_eval.py and inst_eval.py
 * (see tests/accuracy/README.md). "Before" = the baseline measurement of the earlier version
 * on the same recordings with the same scripts. Keep in sync with docs/TRANSCRIPTION.md.
 * Copyrighted test songs are described, never named or shared.
 *
 * SPECIALIST ("High-accuracy piano model", measured 2026-11-12): the browser engine through the
 * real app pipeline (transcribe.mjs --coi --presets specialist, whole recordings, 3 WASM threads, one run at a
 * time) scored by tests/accuracy/specialist_eval.py against the exact MIDI of the six MAESTRO pieces. Averages
 * use the 5 pieces in MAESTRO's TEST split only: the model was trained on the train split, and the Ballade
 * recording is in it (shown, flagged, not averaged). "Fast" = the "Piano solo" (Basic Pitch) run of round 2 on
 * the same files. Notes found by register / speed: round-2 register.py rules on the same 5 pieces.
 */
export const ACCURACY_UPDATED = '2026-11-12';

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
    sub: '6 recorded performances with an exact answer key, “Piano solo” preset (62–92% per piece; was 78%). With the high-accuracy piano model: 98% on the 5 it was not trained on.',
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
    sub: 'Without / with separation, in the browser on a 4-core CPU (3 threads; single-threaded, as in Safari, ≈ 2¼ min). Separation needs about 2 GB of memory.',
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
  { piece: 'Mozart — Sonata in F major, K. 280, 1st mvt.', detail: '3:14 · fast scales and Alberti bass · used for tuning', notes: 1832, f1: 0.87, precision: 0.94, recall: 0.82, f1Sensitive: 0.88, before: 0.86 },
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

export interface SpecialistRow {
  piece: string;
  /** note F1 (pitch exact, onset ±50 ms): high-accuracy model / fast ("Piano solo", Basic Pitch) */
  f1: number;
  f1Fast: number;
  /** onset + offset F1 (end within 20 % of the note's length, at least 50 ms; pedal-extended answer key) */
  ends: number;
  endsFast: number;
  /** Pearson correlation of the played and the transcribed loudness (velocity) of matched notes */
  velR: number;
  velRFast: number;
  /** the recording is in the model's training data (MAESTRO train split): optimistic, not averaged */
  inTraining?: boolean;
}

/** "High-accuracy piano model" vs the normal model on the MAESTRO pieces above (same recordings). */
export const SPECIALIST_ROWS: SpecialistRow[] = [
  { piece: 'J. S. Bach — Prelude & Fugue, BWV 850', f1: 0.9957, f1Fast: 0.9234, ends: 0.9121, endsFast: 0.3664, velR: 0.967, velRFast: 0.546 },
  { piece: 'Debussy — Des pas sur la neige', f1: 0.985, f1Fast: 0.8953, ends: 0.7367, endsFast: 0.168, velR: 0.964, velRFast: 0.47 },
  { piece: 'Mozart — Sonata K. 280, 1st mvt.', f1: 0.9926, f1Fast: 0.8746, ends: 0.9406, endsFast: 0.4306, velR: 0.984, velRFast: 0.728 },
  { piece: 'Chopin — Nocturne Op. 15 No. 1', f1: 0.9678, f1Fast: 0.7514, ends: 0.8781, endsFast: 0.3307, velR: 0.97, velRFast: 0.709 },
  { piece: 'Liszt — Waldesrauschen', f1: 0.9411, f1Fast: 0.6195, ends: 0.7486, endsFast: 0.1614, velR: 0.952, velRFast: 0.556 },
  { piece: 'Chopin — Ballade No. 1, Op. 23', f1: 0.9806, f1Fast: 0.7501, ends: 0.9242, endsFast: 0.2686, velR: 0.972, velRFast: 0.684, inTraining: true },
];

export const SPECIALIST = {
  title: 'High-accuracy piano model',
  intro:
    'A second, optional model for solo piano: ByteDance’s high-resolution piano transcription model (Kong et al., 2021), trained only on piano recordings, running in your browser. Measured on the same answer-key recordings as above, whole pieces, transcribed through the app. The averages leave out the Ballade: that recording was part of the model’s training data, so its score is flattering.',
  /** means over the 5 MAESTRO test-split pieces (not the Ballade) */
  mean: { f1: 0.9764, f1Fast: 0.8128, ends: 0.8432, endsFast: 0.2914, velR: 0.967, velRFast: 0.602 },
  /** notes found, pooled over the same 5 pieces (8,773 notes) */
  found: [
    { what: 'All notes', before: '67%', after: '96%', note: 'and 98% of the notes it writes are real (normal model: 92%)' },
    { what: 'Notes in fast runs (10 or more a second)', before: '58%', after: '94%', note: '5,282 notes; “Sensitive”: 68%' },
    { what: 'Top octave (C6 and up)', before: '36%', after: '88%', note: '852 notes; “Sensitive”: 47%' },
    { what: 'Lowest notes (below C2)', before: '28%', after: '78%', note: 'only 60 such notes in these pieces' },
    { what: 'The softest third of the notes', before: '57%', after: '91%' },
  ] as CompareRow[],
  /** speed, memory and download: 11 whole recordings (6 MAESTRO + 5 other piano recordings), 4-core CPU */
  cost: [
    { what: 'Time per minute of audio, 3 processor threads', before: '≈ 7 s', after: '≈ 38 s', note: '36–41 s on 11 recordings: a 4-minute piece takes about 2½ minutes' },
    { what: 'With one thread (Safari, and pages without cross-origin isolation)', before: '≈ 7 s', after: '≈ 97 s', note: 'Mozart, 3:14 piece: 5¼ minutes, the same notes as with 3 threads' },
    { what: 'On an iPhone (one test, an 8-minute piece)', before: '—', after: '≈ 9 min', note: 'About 70 s per minute of audio, timed by hand by a user (2026-11-12); it finished without problems. Older phones may be slower' },
    { what: 'Peak memory of the browser tab', before: '0.4–0.7 GB', after: '0.8–0.9 GB', note: 'About 0.7 GB more than the tab uses before an import (0.66–0.75 GB measured), more for very long recordings; freed when it is done' },
    { what: 'Download', before: 'included', after: '41 MB, once', note: 'Kept in the browser’s cache; it also needs the app’s 15 MB WebAssembly engine, shared with vocal separation' },
  ] as CompareRow[],
  useWhen: [
    'Solo piano recordings — classical, jazz or pop piano — when you want the notes close to exact: far fewer missed notes in fast runs and high passages, note lengths close to how long each note really sounds (sustain pedal included), and loudness that follows the touch.',
    'On a computer, or on a phone if you can wait: on an iPhone an 8-minute piece took about 9 minutes (one test). It needs a lot of memory, so songs over 6 minutes might not work on phones with little memory.',
  ],
  skipWhen: [
    'Songs with vocals, drums or a band: it only knows the piano, so it is not offered with “Full song” and separation is not used with it.',
    'A quick first look, or when you want to re-tune detection with the sliders afterwards (its notes cannot be re-tuned; re-import with the normal model to do that).',
  ],
  notes: [
    'It was trained on other performances from the same dataset (Yamaha Disklavier concert grands, similar recording setup), so on very different pianos, rooms or home recordings expect lower numbers than these.',
    'The browser version gives the same notes as the original Python version of the model: 99.7–100% of notes on the six answer-key recordings, 96–99% on our 5 other piano recordings (MP3 files, which the browser decodes slightly differently). On those 5 that only checks the browser version, not its accuracy: we have no independent answer key for them.',
  ],
};

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
  { song: 'Song 4', detail: 'Funk band · 1:30', easy: 0.57, easyBefore: 0.24, medium: 0.61, mediumBefore: 0.31, best: 0.62, bass: 0.65, bassBefore: 0.48 },
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
    { what: 'Easy right hand plays the lead tune’s note (any octave)', before: '34%', after: '40%', note: 'Best possible from the notes the app hears: 51%. On clearly audible lead moments: 42% → 51%.' },
    { what: 'Easy right hand steps that jump more than an octave', before: '8.4%', after: '0.8%' },
    { what: 'Easy left hand on the bass note', before: '30%', after: '49%' },
    { what: 'Drum hits turned into Easy left-hand notes', before: '2.4/min', after: '6.8/min', note: 'More than before: the left hand now follows the lowest notes closely and some of them are drum hits. A drum filter exists but stays off because it lowered bass accuracy.' },
  ] as CompareRow[],
  notes: [
    'The tune line and the drum and hand-reach rules were tuned on this track, so these numbers are in-sample. Most of the gain comes from the smoother line held on the beat. Counted note by note (ignoring how long notes are held), the notes chosen are about as often right as before (58% → 59%).',
    'In the instrumental breaks of the sung songs, where the right hand also switches to the instruments’ tune, we could not show an improvement — those breaks are short and the estimated tune is unreliable there.',
  ],
};

/** The same (final) app with and without separation, "Full song" preset. */
export const SEPARATION_EFFECT: CompareRow[] = [
  { what: 'Easy right hand plays the singer’s note', before: '24%', after: '50%', note: '5 sung songs; best possible 62%' },
  { what: 'Medium right hand plays the singer’s note', before: '22%', after: '53%' },
  { what: 'Independent check (pYIN pitch tracker), Easy', before: '37%', after: '70%', note: 'clearly sung moments only' },
  { what: 'Easy left hand on the bass note', before: '62%', after: '68%', note: '6 band songs' },
  { what: 'Hard left hand’s lowest note on the bass note', before: '67%', after: '79%', note: '6 band songs' },
  { what: 'Drum hits mistaken for low notes (full transcription)', before: '15/min', after: '13/min', note: 'About the same: up on 3 songs, down on 3' },
  { what: 'Time per minute of audio', before: '7 s', after: '≈ 1 min' },
  { what: 'Peak memory of the browser tab', before: '0.4–0.6 GB', after: '1.9–2.2 GB' },
];

export const PLAYABILITY: CompareRow[] = [
  { what: 'Medium: moments where one hand must stretch more than an octave', before: '4–10%', after: '0%', note: 'Widest stretch per piece 21–41 → 12 semitones. Out-of-reach notes move to the other hand or the least important are dropped.' },
  { what: 'Hard: stretches wider than 14 semitones, solo piano (left hand)', before: '12.5%', after: '7.7%', note: 'Hard keeps every note and only moves notes to the other hand when it is free, so some stretches remain.' },
  { what: 'Hard: the same, band songs (left / right hand)', before: '15% / 6%', after: '12% / 10%', note: 'The right hand now also carries the sung melody on top, so it has more to reach.' },
  { what: 'Long notes chopped into quick repeats of the same key (Hard, band songs)', before: '20%', after: '16%', note: 'Share of notes that restart the same key right after it ends. Many of these are real repeated notes.' },
  { what: 'The same, solo piano / Medium band songs', before: '14% / 11%', after: '13% / 11%', note: 'About unchanged.' },
];

export const SPEED_ROWS: CompareRow[] = [
  { what: 'Full song, total time per minute of audio', before: '7 s', after: '≈ 1 min', note: '6 band songs: 0.11–0.12× / 0.9–1.07× the song’s length' },
  { what: '…of which separating vocals & drums', before: '—', after: '≈ 48 s', note: '3 processor threads (the app page is cross-origin isolated)' },
  { what: 'With one thread only (browsers without cross-origin isolation)', before: '7 s', after: '≈ 2 min 15 s', note: 'Measured on a 1.5-minute song. Safari runs single-threaded: it does not support the isolation the app uses.' },
  { what: 'Piano solo / Sensitive, per minute of audio', before: '7 s', after: '—', note: 'no separation for piano' },
  { what: 'High-accuracy piano model, per minute of audio', before: '≈ 38 s', after: '—', note: '3 threads, 11 piano recordings (36–41 s); ≈ 97 s single-threaded. Peak tab memory 0.8–0.9 GB; 41 MB model downloaded once' },
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
    summary: '87–92% of notes right on clear pieces (Bach, Mozart, Debussy) with very precise timing. Some repeated notes under the pedal are missed.',
    tips: 'Use the “Piano solo” preset. On a computer, “High-accuracy piano model” gets about 99% of the notes on these three pieces. Blend in the original recording to spot mistakes, then fix them in Edit mode.',
  },
  {
    kind: 'Virtuoso or heavily pedalled piano',
    examples: 'Chopin, Liszt, Debussy, concert-hall recordings',
    rating: 3,
    measured: true,
    summary: '62–75% of notes right on concert performances with “Piano solo” (71–78% with “Sensitive”): fast runs, soft inner voices and the top octave are often missed, but what is written is usually right.',
    tips: 'Try “Sensitive” — it finds more notes in fast or soft music (Liszt 62% → 71%). On a computer, “High-accuracy piano model” does much better (Liszt 94%, Nocturne 97%), in a few minutes per piece.',
  },
  {
    kind: 'Jazz piano',
    examples: 'Solo jazz piano, covers, ballads',
    rating: 3,
    measured: true,
    summary: 'Chords and melody come through; swing rhythm, dense voicings and which hand plays what are the hardest parts (one recording, compared with a second AI model: 56–63% agreement).',
    tips: 'Try “Sensitive” or “High-accuracy piano model” (we have no answer key for jazz, so we can’t say how much it helps here), set the tempo manually if the beat grid looks off, and check the hand split in Edit mode.',
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
  { title: 'Fast passages', body: 'Quick runs lose more notes than slow music (57% found vs 78%). “Sensitive” helps (68%) at the cost of a few more wrong notes. On solo piano, the high-accuracy piano model finds 94% of them (on the five pieces it was not trained on).' },
  { title: 'Very high and very low notes', body: 'The top octave is found less often (39%; 52% with “Sensitive”) and the lowest notes below C2 are mostly missed. The high-accuracy piano model finds most of both on solo piano (88% and 78%). On band songs, drum hits are sometimes written as low notes.' },
  { title: 'Note lengths and the pedal', body: 'Start times are precise, end times are not: the sustain pedal isn’t detected and only 15–45% of notes end at the right moment. Playback sounds right because note lengths include the ringing. MIDI imports keep their pedal. On solo piano, the high-accuracy piano model gets most note ends right (74–94%).' },
  { title: 'Left / right hand', body: 'Hands are assigned by rules (pitch gaps and reach), not by watching a pianist. Medium never asks one hand to stretch more than an octave; Hard keeps every note, so a few wide stretches remain.' },
  { title: 'Octaves and overtones', body: 'A loud low note contains its own octave above. We filter these “ghost” notes, but real doubled octaves played softly can be removed by mistake, and vice versa.' },
  { title: 'Long songs and phones', body: 'Separating vocals & drums needs about 2 GB of memory and roughly a minute per minute of audio, so it is off by default on phones and skipped for recordings over 10 minutes (20 on devices with 8 GB or more); the right hand then does not follow the singer. On phones the notes are detected on the processor (WebAssembly), not the graphics chip, to stay within the phone’s memory.' },
];

export const METHOD_NOTES: string[] = [
  'Every number comes from the real app running in a browser (Chromium, WebAssembly, no GPU) on the complete recordings — not excerpts — with the preset the import page suggests. “Before” is the earlier version measured the same way on the same recordings.',
  'Notes right (F1): a note counts when its pitch is exact and it starts within 50 ms of the real one — the standard measure in music-transcription research. F1 combines how many real notes were found with how many written notes were real.',
  '“Follows the singer / the tune”: 100 times a second we compare the highest right-hand note with the reference pitch and count a match when the note name is the same in any octave (the moments the right hand is silent count as misses).',
  'Only the MAESTRO piano pieces have an exact answer key. Everything else is compared with AI-made references — a piano-specialist transcriber, and pitch tracking of vocal, bass and lead tracks separated with Demucs. They are second opinions, not the truth, and we say so wherever they are used.',
  'Some settings were tuned on the same recordings (the piano presets on five MAESTRO pieces, the melody on the five songs, the instruments’ tune line and the drum, chopped-note and hand-reach rules on the instrumental track and the piano recordings), which flatters those numbers a little; the held-out Liszt étude, the other piano recordings’ note scores and the independent pYIN check are the fairer tests.',
  'The high-accuracy piano model was measured the same way (the app in the browser, whole recordings, one at a time). Its model was trained on MAESTRO’s training recordings, so only the five answer-key pieces from MAESTRO’s test set count in its averages; the Ballade, a training recording, is shown but flagged. On recordings without an answer key we can only compare it with its own original Python version, which checks the browser version, not accuracy.',
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
  { name: 'High-resolution Piano Transcription (ByteDance)', use: 'Original Python version of the high-accuracy piano model: second opinion for piano recordings without an answer key, and the check that the browser version gives the same notes', license: 'MIT (inference code); CC BY 4.0 (weights)', url: 'https://github.com/qiuqiangkong/piano_transcription_inference' },
  { name: 'Demucs (Meta AI)', use: 'Separated vocal, bass, drum and lead tracks for the references (not used by the app)', license: 'MIT (code); weights for research use', url: 'https://github.com/facebookresearch/demucs' },
  { name: 'CREPE / torchcrepe', use: 'Pitch of the singer and the bass on those tracks', license: 'MIT', url: 'https://github.com/maxrmorrison/torchcrepe' },
  { name: 'librosa (pYIN) & mir_eval', use: 'Independent second pitch tracker; standard accuracy metrics', license: 'ISC; MIT', url: 'https://github.com/mir-evaluation/mir_eval' },
  { name: 'Test songs and recordings', use: '5 songs with a singer, 1 instrumental soundtrack track, 4 commercial piano recordings — used privately for measuring only, never copied into the app or shared', license: 'Copyrighted (not distributed)' },
];

/**
 * Sheet-music reader (beta, src/lib/omr): measured 2026-11-13 with the shipped pipeline (Sheet Music
 * Transformer, Camera-GrandStaff checkpoint, 8-bit weights) in headless Chromium, the way the app's
 * import job runs it, after the review fixes. Rows use pages the reader was NOT tuned on: 16 new pieces
 * generated in code (keys, metres and textures the tuning pages lack), engraved by two notation programs,
 * plus 6 public-domain Mutopia pages; photos are simulated. public/models/omr/README.md has the details.
 * Notes / rhythm: see `metric`.
 */
export const SHEET_READER = {
  intro:
    'Printed piano music in a PDF or a photo is read by the Sheet Music Transformer, an AI model that runs on your device. It is a Beta: it gets most notes right on clear printed pages, but rhythm mistakes are common, and photos are harder than PDFs. The photo numbers below come from simulated phone photos; real phone photos have not been measured yet.',
  rows: [
    { what: 'Clean printed PDFs', note: '16 new test pieces in many keys and time signatures, exact answer key', before: '88%', after: '81%' },
    { what: 'Clean printed pages, another notation program', note: 'the same 16 pieces, engraved differently', before: '90%', after: '83%' },
    { what: 'Real printed scores', note: '6 public-domain pages (Mutopia Project: études, Bach songs)', before: '80%', after: '59%' },
    { what: 'Simulated phone photos, corners set', note: 'the 16 pieces with tilt, shadow, blur and JPEG noise added', before: '87%', after: '77%' },
    { what: 'Simulated photos of real scores, corners set', note: 'the 6 Mutopia pages', before: '76%', after: '55%' },
    { what: 'Simulated phone photos, corners not adjusted', note: 'automatic corners (one of 16 found no music); on photos of real scores only 50% of notes', before: '76%', after: '68%' },
    { what: 'Curved page, blur or dim light (simulated)', note: 'even with the corners set exactly', before: '32%', after: '19%' },
  ],
  metric:
    '“Notes right” counts notes found with the right pitch in the right order (missed and extra notes both count against it); a note still counts when it comes at the wrong time. “Rhythm right” also needs the time since the previous note to be right. On the 12 pages we tuned the reader on it scored 93% / 84%; those are left out above because they flatter it.',
  speed:
    'A full page of piano music took 20–35 seconds on a computer (a page with two lines: a few seconds). Phones are slower: we estimate about 50 seconds a page (not yet measured on a real phone), so a phone reads up to 3 pages at a time. The reader is a 24 MB download, once, and needs about 0.5–1 GB of memory while it reads.',
  limits: [
    { title: 'Printed piano music only', body: 'Two staves (right and left hand). A vocal line, more than two staves, or band and orchestra scores come out wrong.' },
    { title: 'Lay the page flat', body: 'A curved page, a blurry or dim photo comes out mostly wrong, even with the corners set. Lay the page flat, light it evenly and hold the phone straight above it.' },
    { title: 'Rhythm is the weak spot', body: 'The reader sometimes reads a note twice or gets a length wrong. A bar with too many beats is made longer so no note is lost; the notes after it then come a little later than on your page.' },
    { title: 'Very high or very low notes', body: 'Notes with many ledger lines above or below the staff (or under an 8va sign) are often missed or put in the wrong octave.' },
    { title: 'One key', body: 'The key used most is kept for the whole piece; a key change partway through is not followed. If the key signature is misread, every sharp or flat note is a semitone off — the app warns when lines disagree.' },
    { title: 'No handwriting, no text', body: 'Hand-written music is not supported. Lyrics, chord symbols, fingering, dynamics and tempo words are not read.' },
    { title: 'Repeats as written', body: 'Repeat signs are not followed: the music plays straight through, as printed.' },
  ],
} as const;
