# Transcription pipeline

```
file ─► validate (type, ≤300 MB, ≤20 min) ─► decode + resample to 22 050 Hz mono
     ─► [optional: Demucs separation on the processing server]
     ─► level normalisation ─► Basic Pitch CNN (Web Worker, TF.js)
     ─► note extraction ─► cleanup ─► hand assignment ─► beat tracking ─► key detection
     ─► Easy / Medium / Hard arrangements
```

## 1. Decoding

`decodeAudioData` on an `OfflineAudioContext` at 22 050 Hz decodes **and** resamples in one native step (MP3, WAV, AAC/M4A, MP4, FLAC, OGG, Opus/WebM where the browser supports them). Containers the native decoder rejects (MKV, some MOV/MP4 variants) are decoded with mediabunny/WebCodecs and resampled with the browser's resampler. Near-silent files are rejected with an explanation; quiet ones are normalised and flagged.

## 2. Neural pitch estimation (Basic Pitch)

We run Spotify's Basic Pitch model (`public/models/basic-pitch`, Apache-2.0) with **our own inference loop** instead of the `@spotify/basic-pitch` JS wrapper, because the wrapper:

1. **drifts in time** — its frame→time conversion subtracts 12.6 ms per 172 frames, but consecutive 2-second windows actually overlap by 188 samples (8.5 ms) per 142 kept frames. Over a 3-minute song the error grows to ~0.2 s, which visibly desynchronises the piano roll. Our `frameToTime` is exact (`(k·36164 + i·256) / 22050` for kept frame *i* of window *k*), and the benchmark shows **no measurable drift** (onset error 0.0 ms in the first third vs 0.7 ms in the last third of a 2-minute piece);
2. **leaks tensors** every window (memory grows with song length); we dispose everything per batch;
3. runs one window at a time; we batch 4 windows on WebGL.

Progress reported to the UI is the real fraction of windows processed.

## 3. Note extraction

A typed-array port of Basic Pitch's `output_to_notes_polyphonic`:

* peak-pick the onset posteriorgram (optionally merged with positive frame differences),
* track each onset forward while frame activation stays above the frame threshold (tolerating short dips),
* optionally the **melodia trick**: recover sustained pitches without onsets — rewritten to iterate pre-sorted candidates instead of rescanning the whole matrix per note (identical output, O(n log n) instead of O(n²)).

## 4. Piano-aware cleanup

* **Continuation merge** — a same-pitch note with a *weak* model onset that starts while (or just after) an earlier note of that pitch is ringing is the same string resonating under the pedal/reverb, not a new key press; it is folded into the earlier note. This was the largest source of false notes on piano.
* **Fragment merge** — tiny gaps (< 30 ms) inside one note are closed unless there is a strong onset.
* **Overtone suppression** — a quiet note an octave, twelfth or two octaves above a louder simultaneous note, which doesn't outlast it, is removed (real doubled octaves are played at similar loudness and survive).
* **Onset latency calibration** — the model reports piano onsets ~7 ms late on average; this is subtracted.
* **Velocity** — combines the model's note confidence with the audio's RMS loudness at the onset.

## 5. Hands, beats, key

* **Hands**: per 1.5 s window, the split point is the widest pitch gap among sounding notes (biased toward middle C and the previous split, median-smoothed); each chord is then checked so neither hand spans more than 14 semitones or 5 notes.
* **Tempo & beats**: onset-strength envelope at 100 fps → autocorrelation with a log-normal tempo prior, *plus* the periodicity of the lowest voice (bass lines move on beats/half-bars), which resolves ambiguous figurations (e.g. Bach's 3-note arpeggios that otherwise read as 88 instead of 66 BPM) → Ellis dynamic-programming beat tracker (follows tempo drift) → meter (3 vs 4) and downbeat from bass/accent periodicity.
* **Key**: Krumhansl–Schmuckler profiles on a duration-weighted pitch-class histogram; drives sharps/flats in labels.

## 6. Difficulty levels

| Level | Right hand | Left hand | Rhythm |
| --- | --- | --- | --- |
| **Hard** | everything | everything | original timing |
| **Medium** | melody + up to 2 consonant chord tones within an octave; passages thinned to a 16th grid | bass + 1 consonant tone; at most one attack per 8th | light quantisation to 16ths |
| **Easy** | single melodic line: skyline of the right hand, ornaments removed, one note per 8th, kept in a comfortable register, octave jumps folded | one sustained bass note per half bar (per beat in slow music), transposed into G2–A3, kept below the melody | quantised to 8ths |

Quantisation strength is scaled by tempo confidence so a poorly tracked tempo never drags notes onto a wrong grid.

## Accuracy benchmark

`tests/e2e/harness.ts` renders pieces with known notes through the real piano engine (Salamander samples + hall reverb), transcribes the audio in the browser and scores note onsets mir_eval-style (pitch exact, onset within 50 ms):

| Piece | Stock Basic Pitch settings | PianoVision "Piano solo" preset |
| --- | --- | --- |
| Bach, Prelude in C (BWV 846), 517 notes, pedalled | F1 0.77 (P 0.63 / R 0.96) | **F1 0.94** (P 0.93 / R 0.94) |
| Chord/melody study with octaves & repeated chords, 224 notes | F1 0.78 | **F1 0.88** (P 0.92 / R 0.84) |

Mean onset error after calibration: 0.6 ms (Bach) / 4.4 ms (study), no drift. Tempo: 65.9 BPM detected for 66, 120 for 120; keys correct. On a real CC0 recording of Chopin's Nocturne Op. 55 No. 1 (5 min 17 s) the key (F minor) was identified correctly and processing took 39 s on a 4-core VM without GPU.

Synthetic benchmarks flatter any transcriber (clean, single instrument); real recordings with room noise, and especially full band mixes, score lower. That is why every audio transcription is labelled *AI transcription*, the original can be blended in for comparison, detection can be re-tuned instantly, and all notes are editable.

### Presets

| Preset | Use for | Key settings |
| --- | --- | --- |
| Piano solo | piano recordings | onset 0.5, frame 0.4, melodia off, continuation 0.7 |
| Full song | bands, vocals | frame 0.35, melodia on (sustained vocal lines), range E1–E7 |
| Sensitive | quiet/fast playing | onset 0.4, frame 0.3, 50 ms minimum |
