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

"Piano solo" + "High-accuracy piano model" (opt-in, section 3b):
file ─► validate ─► decode + resample to 16 000 Hz mono ─► piano specialist (ONNX, WASM worker)
     ─► regression post-processing (onset / offset / velocity) ─► hands ─► beats ─► key ─► arrangements
```

## Two engines

| | **Basic Pitch** (default) | **Piano specialist** ("High-accuracy piano model", opt-in) |
| --- | --- | --- |
| Model | Spotify Basic Pitch, a small general-purpose model (any instrument, voice) | ByteDance high-resolution piano transcription (Kong et al. 2021), trained only on solo piano (MAESTRO) |
| Use for | everything: full songs, bands, singers, and quick piano imports | **solo piano recordings** when accuracy matters more than time |
| Not for | – | songs with vocals, drums or other instruments (it was never trained on them; use "Full song" with separation) |
| Notes, solo piano (MAESTRO, exact MIDI, onset F1) | 0.62–0.92 (mean 0.80) | 0.94–0.996, mean 0.976, in the browser on the 5 MAESTRO test-split pieces (the ones it was not trained on; Basic Pitch on the same 5: mean 0.81) |
| Note ends / velocity | ends weak (onset+offset F1 ≈ 0.29), velocity estimated from loudness | ends and velocities regressed by the model (onset+offset F1 0.74–0.94, mean 0.84; velocity correlation 0.97 vs 0.60) |
| Download | ≈ 0.9 MB, part of the site | ≈ 41 MB model (`public/models/piano-specialist`), downloaded the first time it is used, then cached by the browser |
| Time per minute of audio (4-core desktop) | ≈ 7 s | ≈ 38 s with 3 WASM threads (36–41 s on 11 whole piano recordings of 2–10 min, 2026-11-12, decoding and arranging included); up to ≈ 60 s while the shared test machine was busy (load ≈ 5); ≈ 97 s single-threaded (Safari, pages that are not cross-origin isolated; same notes as with 3 threads) |
| Extra memory | – | ≈ 750 MB while it runs (measured +720 MB RSS for the whole browser through the real app; peak tab 0.78–0.87 GB on 11 recordings, 0.66–0.75 GB above the idle tab) |
| When it is used | always, unless "High-accuracy piano model" is picked | only when picked (off by default on every device; the choice is remembered). Phones and low-memory devices (`backendChoice.ts isMemoryConstrained`) are told it is not recommended there: ≈ 750 MB more memory and slower (one iPhone test: an 8-minute piece in ≈ 9 minutes, ≈ 70 s per audio minute, single-threaded) |
| Re-tune detection afterwards | yes (stored posteriors) | no Basic Pitch posteriors are stored, so the detection re-tuning does not apply to these notes |

The specialist is offered with the "Piano solo" preset only. Separation ("Separate vocals & drums") is never combined with it.

Everything runs on the user's device. Measured accuracy on real recordings is on the in-app
**Accuracy** page (`/accuracy`, numbers in `src/lib/accuracyStats.ts`); how it was measured is in
`tests/accuracy/README.md`.

## 1. Decoding

`decodeAudioData` on an `OfflineAudioContext` at 22 050 Hz decodes **and** resamples in one native step (MP3, WAV, AAC/M4A, MP4, FLAC, OGG, Opus/WebM where the browser supports them). Containers the native decoder rejects (MKV, some MOV/MP4 variants) are decoded with mediabunny/WebCodecs and resampled with the browser's resampler. Near-silent files are rejected with an explanation; quiet ones are normalised and flagged.

## 2. Source separation (optional, "Full song")

With **Separate vocals & drums** (on by default for the "Full song" preset where the device is suitable) the song is split by **SCNet** (int8 ONNX, MIT, `public/models/scnet`) running in a worker with ONNX Runtime Web (`src/lib/separation`), or the stems come from the processing server (`server/`, same model on CPU).

* The **accompaniment** (bass + other: no vocals, no drums) is transcribed with the chosen preset instead of the full mix. When the vocal stem holds **no singing** (an instrumental), or singing from which no melody line could be extracted, it is added back in before transcription (`pipeline.ts vocalsIntoAccomp` / `addVocalsInto`): SCNet has only four stems and puts parts of lead instruments into "vocals" (in an instrumental band test track, 35–62 % of the closing lead's energy). It is added only where it carries a real share of the sound (within 20–30 dB of the accompaniment, per ~93 ms block); elsewhere it is separator residue 40–50 dB down that only flips near-threshold notes.
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

## 3b. Piano specialist ("High-accuracy piano model")

`src/lib/pianoSpecialist` runs the **note model** of ByteDance's *High-resolution Piano Transcription with Pedals by Regressing Onset and Offset Times* (Qiuqiang Kong, Bochen Li, Xuchen Song, Yuan Wan, Yuxuan Wang; IEEE/ACM TASLP 2021, arXiv:2010.01815) with ONNX Runtime Web in a module worker (same WASM asset and thread setup as the separation worker: `isolation.ts wasmThreads()`).

* **Model file**: five pieces `public/models/piano-specialist/piano-note.fp16.part1.bin` … `part5.bin` (~8.2 MB each, under Netlify's 10 MB per file); `cat piano-note.fp16.part*.bin > piano-note.fp16.onnx` joins them into the 41 MB model (sha256 and provenance in that folder's README). The worker fetches and joins the pieces itself; `piano-note.fp16.onnx` is only its Cache API key and is not served — checkpoint `CRNN_note_F1=0.9677_pedal_F1=0.9186.pth` (Zenodo record 4034264) → `tests/accuracy/pti_export.py` → ONNX opset 17, input 10 s of 16 kHz audio, outputs frame / regressed onset / regressed offset / velocity, each 1001 × 88 at 100 frames/s. The log-mel front end is inside the graph. Weights are **stored as float16** and cast to float32 in the graph (half the download; outputs unchanged at the thresholds). int8 quantisation broke the GRUs and was slower, so it is not used. The pedal model is not shipped.
* **Post-processing** (`pianoSpecialist/postprocess.ts`): a line-by-line port of `piano_transcription_inference` 0.0.6's `RegressionPostProcessor` (onset 0.3, offset 0.3, frame 0.1; velocity × 128; notes without a detected offset close after 6 s), checked against the Python package on dumped model outputs. None of the Basic Pitch cleanup runs on its notes (those rules fix Basic Pitch's posteriors and only removed correct notes here); hands, beats, key and the Easy / Medium / Hard arrangements are the same as for Basic Pitch.
* **Offsets** follow the model's training targets: a note lasts while the key or the sustain pedal holds it, so durations match what you hear.
* **Cancel** stops the worker; the model stays in the browser's HTTP cache.
* **Memory and crashes**: ~700 MB extra plus ~0.25 MB per second of audio (`protocol.ts specialistMemoryMB`; ~750 MB for 4 minutes, ~1 GB for 20). On phones, tablets and ≤ 4 GB devices (offered, not recommended) it runs on any length, but the checkbox warns that songs over 6 minutes might not work there (`PTI_CONSTRAINED_MAX_SECONDS`). While the model runs, a crash marker (`piano2vision-piano-specialist-running` in localStorage plus a Web Lock, like in-browser separation's) is set; a tab that dies mid-run leaves it behind, and the next load selects the normal model again, says so in a toast, and resumes that interrupted import with Basic Pitch (always so on memory-constrained devices). Out-of-memory and download errors are shown in plain words, and the error card offers "Try with the normal model".

Measured 2026-11-12 (the app's real pipeline in Chromium, whole recordings, 3 WASM threads, one at a time), against MAESTRO's exact performance MIDI (onset ±50 ms; onset+offset in brackets): Bach BWV 850 0.996 (0.91), Debussy *Des pas sur la neige* 0.985 (0.74), Mozart K. 280/i 0.993 (0.94), Chopin Nocturne Op. 15/1 0.968 (0.88), Liszt *Waldesrauschen* 0.941 (0.75) — mean 0.976 (0.84), Basic Pitch "Piano solo" on the same five 0.813 (0.29); velocity correlation 0.97 (0.60). The original PyTorch model on the same audio: mean 0.978. Chopin's Ballade No. 1 scores 0.981 but is in MAESTRO's **train** split, which the model learned from, so it is not counted. The browser version must reproduce the Python numbers on every piece: `tests/accuracy/specialist_eval.py` scores the browser runs against the same MIDI and checks parity with the Python package note by note (`tests/accuracy/run_specialist.sh` runs everything); `tests/e2e/specialist.mjs` is the browser regression check. On recordings without exact MIDI the only comparison available is this same model in Python, so for the specialist it measures the port, not accuracy.

Licences: trained weights **CC BY 4.0** (Zenodo record 4034264; changes: converted to ONNX with float16 weights, pedal model removed); inference code `piano_transcription_inference` **MIT** (PyPI metadata; the repository has no LICENSE file); training code `bytedance/piano_transcription` **Apache-2.0** (stated in its README); the STFT / log-mel layers in the graph come from torchlibrosa (MIT). Attribution is on the Credits page (`src/lib/credits.ts`). The model was trained on MAESTRO (CC BY-NC-SA 4.0); the dataset itself is not distributed.

## 4. Note extraction and cleanup

A typed-array port of Basic Pitch's `output_to_notes_polyphonic` (peak-picked onsets, notes tracked while the frame activation stays above threshold, optional melodia trick for sustained pitches without onsets), plus:

* **Register curve** (`PIANO_REGISTER`, "Piano solo" and "Sensitive"): the top and bottom octaves get lower thresholds because the model's posteriors are weaker there. On MAESTRO, recall of notes at C6 and above went from 21 % to 39 % ("Sensitive" 41 % → 52 %) at unchanged precision.
* **Chopped-note join** (`noteExtraction.ts REPEAT_JOIN`): a held note interrupted by other notes' attacks comes out as back-to-back same-pitch fragments; they are joined unless the second onset is a real re-strike (the activation rises again or the onset stands on its own). Real repeated notes are kept.
* **Continuation merge** — a same-pitch note with a weak onset while an earlier note of that pitch is ringing is the same string resonating under the pedal, not a new key press.
* **Bass re-strike rule** (`RESTRIKE`) keeps repeated bass notes apart; **fragment merge** closes tiny gaps; **overtone suppression** removes quiet octave/twelfth ghosts of louder notes; **velocity** combines model confidence with RMS loudness.
* **Ghosts in near-silence** (`music/cleanup.ts TAIL_GATE`): Basic Pitch level-normalises each 2 s window, so reverb tails, fade-outs and a separated stem's noise floor turn into notes on window boundaries after a song ends. A note starting more than 50 dB below the song's loudness reference is dropped anywhere; in the song's tail (after its last frame within 25 dB of the reference, when that is the last 10 s or less) also one more than 40 dB below it, or more than 30 dB below it with no level rise at its onset. Soft sections and quiet endings longer than 10 s are left alone: on MAESTRO with half of each piece made 10–20 dB quieter it removes at most one real note per piece. Notes are also cut at the end of the audio.
* **Lead-line recovery** ("Full song" only, `music/leadRecovery.ts`): in a band mix the lead instrument is often not the loudest pitch, and its notes fall under the main thresholds (a gliding solo comes out as 35–100 ms fragments). A second, more sensitive extraction of the same posteriors (`EXTRACTION_PRESETS.mix.leadPass`: frame 0.3, 50 ms, MIDI 60–100; no second model run) proposes candidates; a candidate is kept only where the instruments' tune line (`melody.ts instrumentLine`) goes through it and the posteriors support it, at most 4 per second, never inside sung phrases. They are Hard-only (`role: 'lead'`): Easy and Medium are built without them (with them, Easy got busier without a gain that held against independent references). On an instrumental band test track, Hard now has 71 % of an estimated lead line's solo notes without separation (was 20 %) and 80 % with it (was 39 %), while adding far fewer stray notes than "Sensitive". These settings were chosen on that same track; against references that share nothing with the tuning the whole-song gain is about half as large, the solo gain holds. The pass is not stored with a song (`leadPassParams` reads it at run time) and is skipped when the main thresholds are already as low. The posterior test runs before the line is chosen (a faint octave above a lead note no longer wins the line and leaves a hole), a candidate needs a model onset at its start (chord tones and held accompaniment have none; a clear onset lowers the activation needed, for fast solo notes), a candidate an octave above a much stronger sounding main note is dropped as its overtone, and a candidate that re-strikes a same-pitch main note splits it (repeated tune notes). On the same track: recovered notes on the lead 38 → 43 %, Hard lead-note recall 63 → 65 %, solo 80 → 83 % (thresholds chosen on that track).
* **Held tune notes** ("Full song" only, no sung line; `music/sustain.ts`): a sustained lead under a louder accompaniment falls under the frame threshold in the middle of a note, so the tune came out choppy. The notes of the instruments' tune line are held while their pitch's frame posterior stays at 0.2 or above (at most 2.5 s more; never past the next note of that pitch, a new attack, or a clear new note up to an octave below, nor past the next line note), and same-pitch line notes without a new attack become one note. On the instrumental test track the share of lead time with a right-hand note of the lead's pitch class sounding went from 0.75 to 0.81 (Hard), 0.58 to 0.63 (Medium) and 0.56 to 0.59 (Easy). Only line notes are held: holding every right-hand note put held chord tops over the tune.
* **Bass re-detections** ("Full song" only; `cleanup.ts foldBassRestrikes`): the kick drum fires the model's onset head on a held bass note; a same-pitch note below C3 that follows within 0.15 s without a frame-activation rise continues the note before. Fewer drum-synchronous low notes on the six band test songs, bass accuracy unchanged. A drum-hit filter is still off (every variant also removed real bass notes).

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
| Piano solo | piano recordings | onset 0.55, frame 0.4, min 60 ms, melodia off, register curve, continuation 0.7; optionally "High-accuracy piano model" instead of Basic Pitch (section 3b: its own thresholds 0.3 / 0.3 / 0.1, not adjustable) |
| Full song | bands, vocals (with "Separate vocals & drums") | onset 0.5, frame 0.35, min 100 ms, melodia on, inferred onsets, E1–E7; plus the lead-line recovery pass (frame 0.3, min 50 ms, C4–E7, kept only along the tune line) |
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
| "High-accuracy piano model" (browser, `transcribe.mjs --coi --presets specialist`, 5 MAESTRO test-split pieces, scored by `tests/accuracy/specialist_eval.py`) | note F1 Bach 0.996, Debussy 0.985, Mozart 0.993, Nocturne 15/1 0.968, Liszt 0.941 (mean 0.976; Basic Pitch "Piano solo" 0.81); onset + offset 0.84 (0.29); notes found in fast runs 0.94 (0.58), top octave 0.88 (0.36), below C2 0.78 (0.28, 60 notes); 36–41 s per audio minute with 3 threads, 97 s with 1, peak tab 0.78–0.87 GB. Original Python model on the same 5: 0.978; browser vs Python note parity 0.997–1.000 on the 6 MAESTRO WAVs, 0.96–0.99 on 5 MP3 piano recordings. Chopin Ballade No. 1 (train split, not counted): 0.981 (Basic Pitch 0.75) |

Caveats: the piano presets were tuned on five of the six MAESTRO pieces (Liszt is the held-out one: 0.57 → 0.62); the vocal references are AI-made (Demucs stems + CREPE) and the vocal settings were tuned on the same five songs (an independent pYIN reference agrees: 30 % → 70 %); the instrumental track has no answer key (its lead line is pYIN on a Demucs stem, a proxy) and its tune-line, drum and hand-reach rules were tuned on it.

The synthetic e2e benchmark (`tests/e2e/harness.ts`, pieces rendered through the app's own piano engine) stays the regression gate: Bach BWV 846 F1 ≈ 0.94, chord/melody study ≈ 0.88, mean onset error ≈ 8–12 ms (on the real MAESTRO recordings the median error is 4.7 ms). Synthetic benchmarks flatter any transcriber; real recordings score lower, which is why every audio transcription is labelled *AI transcription*, the original can be blended in for comparison, detection can be re-tuned instantly, and all notes are editable.
