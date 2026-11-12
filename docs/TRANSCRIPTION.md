# Transcription pipeline

```
file ─► validate (type, ≤300 MB) ─► decode + resample to 22 050 Hz mono
     ─► [Full song + "Separate vocals & drums": SCNet separation into vocals / drums / accompaniment,
         in the browser (WASM) or on the processing server]
     ─► level normalisation ─► Basic Pitch CNN (Web Worker, TF.js) on the mix or the accompaniment
         [+ a second Basic Pitch pass on the vocal stem when singing is detected]
     ─► note extraction (register curve, chopped-note join) ─► cleanup ─► [vocal melody line]
     ─► hand assignment ─► beat tracking ─► key detection
     ─► Easy / Medium / Hard arrangements (tune line, playability pass)
```

Everything runs on the user's device. Measured accuracy on real recordings is on the in-app
**Accuracy** page (`/accuracy`, numbers in `src/lib/accuracyStats.ts`); how it was measured is in
`tests/accuracy/README.md`.

## 1. Decoding

`decodeAudioData` on an `OfflineAudioContext` at 22 050 Hz decodes **and** resamples in one native step (MP3, WAV, AAC/M4A, MP4, FLAC, OGG, Opus/WebM where the browser supports them). Containers the native decoder rejects (MKV, some MOV/MP4 variants) are decoded with mediabunny/WebCodecs and resampled with the browser's resampler. Near-silent files are rejected with an explanation; quiet ones are normalised and flagged.

## 2. Source separation (optional, "Full song")

With **Separate vocals & drums** (on by default for the "Full song" preset where the device is suitable) the song is split by **SCNet** (int8 ONNX, MIT, `public/models/scnet`) running in a worker with ONNX Runtime Web (`src/lib/separation`), or the stems come from the processing server (`server/`, same model on CPU).

* The **accompaniment** (bass + other: no vocals, no drums) is transcribed with the chosen preset instead of the full mix.
* The **drums** stem is reduced to an onset envelope stored with the posteriors (a drum-hit false-note filter, `music/cleanup.ts DRUM_HIT_RULE`, exists but is off: it lowered bass accuracy).
* If the **vocal** stem really contains singing, it gets its own Basic Pitch pass (`VOCAL_EXTRACTION`) and is reduced to one melody line (section 5).
* Speed: the app routes are cross-origin isolated (COOP `same-origin` + COEP `credentialless`, `netlify.toml` / `vite.config.ts`; the YouTube import route is not, so the embedded player keeps working), which gives the separation worker WASM threads. Measured on a shared 4-core VM: separation ≈ 48 s per minute of audio with 3 threads, ≈ 2 min per minute single-threaded (pages that are not cross-origin isolated, e.g. in Safari, which ignores COEP `credentialless`); whole import ≈ 1 min per minute. Peak tab memory 1.9–2.2 GB, so separation is off by default on phones and skipped for recordings longer than 10 minutes (20 minutes on devices reporting 8 GB).

## 3. Neural pitch estimation (Basic Pitch)

We run Spotify's Basic Pitch model (`public/models/basic-pitch`, Apache-2.0) with **our own inference loop** instead of the `@spotify/basic-pitch` JS wrapper, because the wrapper:

1. **drifts in time** — its frame→time conversion subtracts 12.6 ms per 172 frames, but consecutive 2-second windows actually overlap by 188 samples (8.5 ms) per 142 kept frames. Over a 3-minute song the error grows to ~0.2 s. Our `frameToTime` is exact (`(k·36164 + i·256) / 22050` for kept frame *i* of window *k*); on MAESTRO the median onset error of correctly found notes is 4.7 ms with no drift;
2. **leaks tensors** every window (memory grows with song length); we dispose everything per batch;
3. runs one window at a time; we batch windows on WebGL.

Phones and tablets run the model on WASM (the processor) instead of WebGL, whose texture pool outgrows a phone tab's memory (`transcription/backendChoice.ts`).

Progress reported to the UI is the real fraction of windows processed. Without separation a song takes about 7 s per minute of audio (WASM, no GPU).

## 4. Note extraction and cleanup

A typed-array port of Basic Pitch's `output_to_notes_polyphonic` (peak-picked onsets, notes tracked while the frame activation stays above threshold, optional melodia trick for sustained pitches without onsets), plus:

* **Register curve** (`PIANO_REGISTER`, "Piano solo" and "Sensitive"): the top and bottom octaves get lower thresholds because the model's posteriors are weaker there. On MAESTRO, recall of notes at C6 and above went from 21 % to 39 % ("Sensitive" 41 % → 52 %) at unchanged precision.
* **Chopped-note join** (`noteExtraction.ts REPEAT_JOIN`): a held note interrupted by other notes' attacks comes out as back-to-back same-pitch fragments; they are joined unless the second onset is a real re-strike (the activation rises again or the onset stands on its own). Real repeated notes are kept.
* **Continuation merge** — a same-pitch note with a weak onset while an earlier note of that pitch is ringing is the same string resonating under the pedal, not a new key press.
* **Bass re-strike rule** (`RESTRIKE`) keeps repeated bass notes apart; **fragment merge** closes tiny gaps; **overtone suppression** removes quiet octave/twelfth ghosts of louder notes; **velocity** combines model confidence with RMS loudness.

## 5. Vocal melody (separated songs with a singer)

`music/melody.ts` turns the vocal stem's notes (harmonics, octave doubles, backing vocals, vibrato splits, bleed) into ONE right-hand line: plausible singing range → best path by dynamic programming (note salience × duration, costs for jumps, extra for octave/twelfth jumps) → vibrato/fragment merge → isolated octave errors fixed → rap/spoken sections dropped → whole-line octave transposition only when implausibly low/high. The notes get `role: 'melody'`, hand R, and `mergeMelody()` removes accompaniment notes that would double-strike them.

## 6. Hands, beats, key

* **Hands**: per 1.5 s window the split point is the widest pitch gap among sounding notes (biased toward middle C and the previous split, median-smoothed); chords struck together are checked for reach. Notes still held from earlier onsets are handled per level by the playability pass (section 7).
* **Tempo & beats**: onset-strength envelope at 100 fps → autocorrelation with a log-normal tempo prior plus the periodicity of the lowest voice → dynamic-programming beat tracker → meter and downbeat. There is no tempo answer key for the real recordings; doubled or halved tempi still occur.
* **Key**: Krumhansl–Schmuckler profiles on a duration-weighted pitch-class histogram; drives sharps/flats in labels.

## 7. Difficulty levels

| Level | Right hand | Left hand | Rhythm |
| --- | --- | --- | --- |
| **Hard** | everything | everything | original timing |
| **Medium** | the tune (sung melody, else the instruments' tune) + up to 2 consonant chord tones below it | bass + 1 consonant tone | tune on 16ths, light quantisation |
| **Easy** | one tune line on 8th notes (sung melody, else the instruments' tune), kept in a comfortable register | one sustained bass note per beat window, folded into G2–A3 | quantised to 8ths |

* **The tune**: with a sung line, Easy/Medium follow it (moved by whole phrases into the right-hand register, median E4–E5, clear of the left hand; Hard keeps the sung pitch). Without a singer — or where nobody sings for two bars or more — they follow the **instruments' tune**: `melody.ts instrumentLine` runs the same best-path reduction over the accompaniment's right-hand notes, so the right hand follows ONE smooth lead line instead of hopping between chord tops and the lead instrument (Easy right-hand leaps over an octave: 3.5 % → 1.4 % on MAESTRO, 8.4 % → 0.8 % on an instrumental band track).
* **Playability pass** (`music/playability.ts`, reach per level `MAX_SPAN`: Easy 7, Medium 12, Hard 14 semitones): on Medium, notes out of one hand's reach move to the other hand when it is free and in range, otherwise the least important (inner / doubled) notes are dropped — Medium never asks for more than an octave (was 4–10 % of moments). Hard only reassigns notes to the other hand and keeps every note, so some wide stretches remain where both hands are busy.
* Quantisation strength is scaled by tempo confidence so a poorly tracked tempo never drags notes onto a wrong grid.

## Presets

| Preset | Use for | Key settings |
| --- | --- | --- |
| Piano solo | piano recordings | onset 0.55, frame 0.4, min 60 ms, melodia off, register curve, continuation 0.7 |
| Full song | bands, vocals (with "Separate vocals & drums") | onset 0.5, frame 0.35, min 100 ms, melodia on, inferred onsets, E1–E7 |
| Sensitive | fast or very soft playing | onset 0.55, frame 0.25, min 50 ms, inferred onsets, register curve |

"Piano solo" and "Sensitive" were tuned on five MAESTRO pieces with exact MIDI (Liszt's *Waldesrauschen* held out) and the synthetic e2e pieces; the vocal settings on SCNet stems of five songs.

## Accuracy (summary — details on the Accuracy page)

Measured 2026-11-11 with the real browser pipeline on full recordings (`tests/accuracy`):

| What | Result |
| --- | --- |
| Solo piano, 6 MAESTRO performances with exact MIDI, note F1 (onset ±50 ms) | "Piano solo" 0.80 mean (0.62 Liszt … 0.92 Bach; was 0.78); "Sensitive" 0.82 (was 0.77); precision 0.88–0.94 |
| 5 other solo piano recordings (incl. Chopin's Polonaise Op. 53), agreement with a piano-specialist model | 0.56–0.72 "Piano solo" (was 0.50–0.68) — a second opinion, not truth |
| 5 songs with a singer: Easy right hand plays the singer's note (any octave) | 50 % of sung moments with separation (was 19 %; same app without separation 24 %; best possible ≈ 62 %) |
| Same songs: Easy left hand on the bass note | 71 % (was 52 %) |
| Instrumental band track: Easy right hand vs an estimated lead line | 40 % (was 34 %) |
| Durations (onset + offset F1, MAESTRO) | ≈ 0.29 — the pedal is not detected |

Caveats: the piano presets were tuned on five of the six MAESTRO pieces (Liszt is the held-out one: 0.57 → 0.62); the vocal references are AI-made (Demucs stems + CREPE) and the vocal settings were tuned on the same five songs (an independent pYIN reference agrees: 30 % → 70 %); the instrumental track has no answer key (its lead line is pYIN on a Demucs stem, a proxy) and its tune-line, drum and hand-reach rules were tuned on it.

The synthetic e2e benchmark (`tests/e2e/harness.ts`, pieces rendered through the app's own piano engine) stays the regression gate: Bach BWV 846 F1 ≈ 0.94, chord/melody study ≈ 0.88, mean onset error ≈ 8–12 ms (on the real MAESTRO recordings the median error is 4.7 ms). Synthetic benchmarks flatter any transcriber; real recordings score lower, which is why every audio transcription is labelled *AI transcription*, the original can be blended in for comparison, detection can be re-tuned instantly, and all notes are editable.
