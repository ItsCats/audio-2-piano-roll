# Real-recording accuracy harness

Measures the app's real in-browser pipeline on real recordings. Audio, stems, downloaded references
and results live in a WORK directory OUTSIDE the repo. Copyrighted songs are passed by path only and
are never copied here.

Python: `server/.venv/bin/python` (torch, demucs, librosa, mir_eval, pretty_midi, torchcrepe,
piano_transcription_inference, remotezip). Node 22 + Playwright Chromium.

| step | script | output (under WORK) |
| --- | --- | --- |
| app transcription (base + Easy/Medium/Hard, tempo, key, timing) | `node tests/accuracy/transcribe.mjs --out WORK/transcriptions --port 5302 --presets piano,mix FILES...` | `transcriptions/<id>.<preset>.json` |
| MAESTRO pieces with exact MIDI | `fetch_maestro.py WORK/maestro 2011/MIDI-...wav ...` | `maestro/*.wav + .midi` |
| Demucs stems (htdemucs_6s) | `separate.py WORK/stems FILES...` | `stems/<id>/{vocals,bass,drums,...}.wav` |
| vocal / bass pitch reference | `vocal_ref.py WORK/stems/<id> WORK/refs/vocal/<id>.vocals` (bass: `--stem bass --fmin 35 --fmax 400`; fmin must stay >= 32.7 Hz) | `refs/vocal/<id>.<stem>.f0.npz, .notes.json` |
| vocal reference cross-check (pYIN) | `vocal_ref_check.py WORK/stems/<id> REF.f0.npz --seconds 90` | stdout JSON |
| score MIDI to recording alignment (DTW) | `align_score.py SCORE.mid AUDIO OUT.json [--truth PERF.midi]` | `refs/aligned/<id>.json` |
| piano specialist ONNX export (note model, float16 weights, 5 pieces + sha256) | `server/.venv/bin/python tests/accuracy/pti_export.py CKPT OUT/piano-note.fp16.onnx --split 5 [--from-fp32 FP32.onnx]` (~5 min; seconds with `--from-fp32`) | `OUT/piano-note.fp16.onnx`, `.part1..5.bin`, sha256 on stdout |
| piano specialist parity, Python (float16 ONNX vs float32 PyTorch) | `pti_export_check.py CKPT MODEL.onnx WORK/pti-parity AUDIO[@START+SECONDS] ...` | `pti-parity/<id>.audio16k.f32`, `<id>.{torch,onnx}.*.f32`, JSON (max abs diff, thresholded agreement, note matches) |
| piano specialist parity / speed in Chromium | `node tests/accuracy/pti_export_browser.mjs --dir WORK/pti-parity [--threads 1,3] [--save] IDS...` | one JSON line per run (timings, s/min, peak RSS, diffs vs torch / onnx) |
| strong piano transcriber (the original PyTorch model of the app's "High-accuracy piano model") | `pti_transcribe.py CKPT WORK/refs/pti FILES...` (mono = channel mean, like the package and the app; references made before 2026-11-12 used ffmpeg's 3 dB louder `-ac 1` mix — regenerate them for parity checks) | `refs/pti/<id>.pti.json` |
| the high-accuracy piano model in the browser (the app's specialist engine) | `node tests/accuracy/transcribe.mjs --coi --presets specialist --out WORK/specialist [--timeout-min 20] FILES...` (fresh tab per file, ≈ 38 s per audio minute with 3 threads (36–41 s on 11 recordings, more when the machine is busy), peak tab 0.8–0.9 GB; without `--coi` one thread, ≈ 97 s) | `specialist/<id>.specialist.json` |
| specialist scoring (headline MAESTRO test split, onset / onset+offset / +velocity F1, velocity r, parity with Python, speed, memory) | `specialist_eval.py --work WORK --trans WORK/specialist --out OUT FILES...` | `OUT.json`, `OUT.md` |
| note length of the specialist ("as played" + the pedal heard in the recording, `music/noteLength.ts`) against MAESTRO's key-up times and sustain pedal: on+off F1 against the key-up, length errors, notes held at once per hand, derived pedal P/R/F, the sound of notes + pedal | `notelen_eval.py --maestro DIR --est WORK/specialist [--before OLD_RUNS] [--out OUT] PIECES...` (uses `notelen_hands.mjs` for the app's hands and automatic pedal) | `OUT/notelen_eval.{json,md}` |
| everything for the specialist, strictly sequential, with timeouts | `WORK=... RECORDINGS="..." [PTI_CKPT=...] [ONE_THREAD=1] bash tests/accuracy/run_specialist.sh` | `WORK/specialist/`, `WORK/eval/specialist*.{json,md}` |
| specialist end-to-end check (rendered excerpt, MAESTRO excerpt, cancel) | `node tests/e2e/specialist.mjs [--maestro WORK/maestro/m-mozart-k280-1.wav]` | stdout PASS/FAIL |
| score-informed snapping | `snap_ref.py ALIGNED.json PTI.json OUT.json [--truth PERF.midi]` | `refs/snapped/<id>.json` |
| metric sanity checks | `sanity.py REF AUDIO [VOCAL.f0.npz] [--no-proxies]` | stdout, `$SANITY_OUT` |
| posterior dump | `node tests/accuracy/transcribe.mjs --dump-posteriors WORK/posteriors WORK/maestro/m-*.wav` | `posteriors/<id>.{frames.u8,onsets.u8,rms.f32,post.json}` |
| synthetic e2e posteriors | `node tests/accuracy/sweep_extraction.e2e.mjs --dump WORK/posteriors` | `posteriors/e2e-*` |
| detection sweep (no model) | `node tests/accuracy/sweep_extraction.mjs --post WORK/posteriors --ref WORK/maestro --configs tests/accuracy/sweep_extraction.configs.mjs [--json OUT]` | stdout / JSON |
| evaluation | `evaluate.py --work WORK --out WORK/eval/x FILES...` (config: `songs.json`) | `eval/x.json` |
| Easy RH source analysis | `rh_source.py WORK OUT.json ids...` (needs the app run on stems) | JSON |
| report | `make_report.py EVAL.json OUT.md [--title T] --refs ... --sanity ... --prepend ... --append ...` | Markdown |
| separated app path (in-browser SCNet + vocal melody) | `node tests/accuracy/transcribe.mjs --separate --coi --out WORK/sep --presets mix FILES...` (~2.2 GB, one run at a time; `--coi` = cross-origin isolated page like the shipped app, 3 WASM threads, ≈1 min per audio minute; without it single-threaded, ≈2.3 min) | `sep/<id>.<preset>.json` (with `memory`: peak tab RSS / tree PSS) |
| offline melody / arrangement regeneration from saved runs with posteriors | `node tests/accuracy/melody_regen.mjs [--keep-base] OUTDIR RUN.json ...` (env `MELODY_OPTS` = JSON MelodyOptions overrides) | `OUTDIR/<id>.json` (base/easy/medium/hard/vocalNotes/speech) |
| melody evaluation | `melody_eval.py --work WORK [--out OUT.json] RUN.json ...` | Easy/Medium RH, melody line and ceiling as RPA/RCA/OA/OA-chroma; RPA/RCA on stable-periodicity frames; RH register, LH clearance, speech-section stats, Easy LH bass RCA |
| offline arrangement regeneration from any saved base (loads only music/difficulty.ts) | `node tests/accuracy/inst_regen.mjs OUTDIR RUN.json ...` | `OUTDIR/<basename>` (base/easy/medium/hard, ms) |
| instrumental / solo-piano tune-line evaluation | `inst_eval.py --work WORK [--maestro WORK/maestro] [--pti WORK/refs/pti] [--lead ID=LEAD.npz ...] [--no-drums] [--out OUT.json] RUN.json ...` | Easy/Medium/Hard RH top RPA/RCA/VR vs the MAESTRO MIDI top voice, PTI top voice or pYIN 'other'-stem lead proxy (plus confident frames), and duration-independent note-choice measures next to RCA (onsetPC: RH onset pitch class vs the reference; bothCA: chroma on frames where both sound; legatoRCA: RCA with every RH note held to the next onset; RCA alone rises with longer notes); Easy shape (leaps), LH bass RCA, drum suspects; vocal songs scored on instrumental gaps only (with gap RH note and repeat counts); means per group: exact / pti / lead-band (no sung line) / lead-vocal-gaps |
| CREPE-tiny ONNX export (parity-checked) | `crepe_export.py OUT.onnx` | ONNX file |
| CREPE + Basic Pitch vocal path in Chromium (speed, RSS) | `node tests/accuracy/crepe_track.mjs --out WORK/crepe [--hop 10] [--no-bp] [--coi] ID=VOCALS.wav ...` | `crepe/<id>.*.json` |
| CREPE line variants without re-running models | `node tests/accuracy/crepe_lines.mjs --in DIR --out DIR2 [--variants FILE.mjs]` | `DIR2/*` |
| CREPE parity vs torchcrepe / pYIN references / scoring | `crepe_eval.py parity STEM.wav X.crepe.json`; `crepe_eval.py pyin OUTDIR id=STEM.wav ...`; `crepe_eval.py score --tracks DIR --work WORK --pyin-demucs D1 --pyin-scnet D2 ids...` | stdout / JSON (CREPE reference is circular; pYIN-Demucs is the independent check; P\|V and note-onset F1) |

`transcribe.mjs --override '{"piano":{...}}'` merges candidate values into the app's presets in the page, so candidate presets run through the full browser path.

The separation oracle is the app run on `<id>.vocals.wav` / `<id>.accomp-nodrums.wav`, using the same
transcribe.mjs. evaluate.py picks those runs up automatically when
`transcriptions/<id>.vocals.mix.json` exists.

Build the oracle inputs from the stems (16-bit stereo, 44.1 kHz; the stems are summed, not normalised):

    S=WORK/stems/<id>
    ffmpeg -i $S/vocals.wav -c:a pcm_s16le WORK/oracle/<id>.vocals.wav
    ffmpeg -i $S/bass.wav -i $S/guitar.wav -i $S/piano.wav -i $S/other.wav \
      -filter_complex amix=inputs=4:normalize=0 -c:a pcm_s16le WORK/oracle/<id>.accomp-nodrums.wav

## Round-2 final measurement (how the published numbers were made)

1. Snapshot the commit under test outside the repo (`git archive HEAD | tar -x -C WORK/round2/app`, symlink
   `node_modules`) so parallel edits cannot change the code mid-run; run transcribe.mjs from there with
   `ACC_VITE_CACHE=WORK/round2/vitecache` (a private Vite cache).
2. Band songs: `--separate --coi --presets mix` (Full song + separation) and `--coi --presets mix,piano`;
   solo piano and MAESTRO: `--coi --presets piano,sensitive`. Strictly sequential.
3. Link `<id>.sep.json` → the separated run into one transcription dir and evaluate with a copy of
   songs.json whose band songs list `"presets": ["sep", "mix", "piano"]` (`make_report.py` treats `sep` like
   any preset); then melody_eval.py (sep and mix runs vs the baseline runs), inst_eval.py (MAESTRO / PTI /
   lead proxies) and the independent pYIN-on-Demucs vocal check.
4. The Accuracy page (`src/lib/accuracyStats.ts`) quotes those numbers, rounded.

## Notes on the separated path

- Easy/Medium move the sung line by octaves on purpose (median E4–E5, at least 5 semitones above the
  left hand), so score them with RCA / OA-chroma; RPA is only meaningful for Hard and the melody line.
- Separated songs store the drums stem's onset envelope with the posteriors (`StoredPosteriors.drums`,
  8-bit at 100 fps, `separation/dsp.ts drumOnsetEnvelope`). The drum-hit false-note filter
  (`music/cleanup.ts DRUM_HIT_RULE`) is off by default because it lowered bass RCA; flip `enabled` to
  re-measure.
- `sweep_extraction.mjs` passes the frame posteriors to `cleanNotes`, so it scores the bass re-strike
  rule (`RESTRIKE`) exactly as the app applies it. It also prints onset+offset F1 (`F+off`, against a
  sustain-pedal-extended MAESTRO reference) and a per-piece `splitRate` (share of notes restarting the
  same pitch within 40 ms of the previous one ending) in the JSON. Chopped-note joining is
  `transcription/noteExtraction.ts REPEAT_JOIN`; a config with `extraction: { joinRepeats: null }`
  scores without it (the vocal stem runs without it: `VOCAL_EXTRACTION.joinRepeats = false`).
- Hand reach per level is `music/playability.ts MAX_SPAN` (Easy 7, Medium 12, Hard 14 semitones);
  `spanStats` measures onsets where one hand holds more than a given span.
- The CREPE-tiny tracker (`src/lib/pitch`) is built and measured but not wired into the app: against
  the independent pYIN-on-Demucs reference its gain was small and mixed (+0.02 RPA mean, worse on one
  song of five).

## Notes on the piano specialist ("High-accuracy piano model")

- Preset id `specialist` everywhere in the harness (`songs.json` lists it for the solo-piano recordings; `transcribe.mjs`
  passes `engine: 'piano-specialist'` to `transcribeAudio`). The run JSON has the same format (no posteriors, `params` null);
  `timing.stagesMs` has `loading-model` (the first run of a browser downloads the model) and `analyzing`.
- Headline numbers come ONLY from the MAESTRO pieces with exact performance MIDI in the **test** split
  (`songs.json maestroSplit`). The model was trained on the MAESTRO v2.0.0 train split; `m-chopin-ballade1` is a train
  piece (looked up in maestro-v2.0.0.csv / v3.0.0.csv, same split in both) and is reported but never averaged.
- Circular references: `refs/pti` IS this model (Python), and the `snapped` score references take their timing from it.
  For the specialist both measure the browser port (parity), not accuracy; specialist_eval.py reports them as parity.
  Basic Pitch's vs-PTI numbers remain a strong-model proxy.
- Note length: since 2026-11-14 the specialist's `base` notes are "as played" (a note ends when its key is let go) and
  the run JSON has `pedal` (the pedal heard in the recording; docs/TRANSCRIPTION.md section 3d). specialist_eval.py scores
  them as heard (the pedal applied to the note ends, as playback does) so its numbers stay comparable; notelen_eval.py
  scores the note lengths against the key-up times. As heard is a close reconstruction of the model's own ends, not an
  exact one: onset+offset F1 against the pedal-extended MIDI on the 5 test-split pieces 0.843 (model's ends) → 0.815, and
  the parity check's offset differences grow by the same amount; onset numbers are identical.
- Offsets: MAESTRO references are extended by the sustain pedal (`acclib.midi_notes(pedal_extend=True)`), which is also
  how the model's training targets were made, so onset+offset F1 is meaningful for it (Basic Pitch has no pedal and scores
  ≈ 0.3 there).
- Velocity: `onsetOffsetVelocity` is mir_eval.transcription_velocity (tolerance 0.1 after its linear fit, so the scale does
  not matter); `velocityPearson` is the correlation of matched notes' velocities.
- Licences (checked 2026-11-12): checkpoint CC BY 4.0 per the Zenodo API (`license.id: cc-by-4.0`, record 4034264), and the
  local `CRNN_note_F1=0.9677_pedal_F1=0.9186.pth` matches the record's md5 `22b961b77c1878239fec963362097045`;
  piano_transcription_inference 0.0.6 MIT (PyPI classifier and setup.py; the repository has no LICENSE file);
  bytedance/piano_transcription Apache-2.0 (its README; no LICENSE file); torchlibrosa 0.1.0 MIT (LICENSE.md in the wheel).
  Authors from the paper (arXiv:2010.01815 v0.2 PDF in bytedance/piano_transcription): Qiuqiang Kong, Bochen Li,
  Xuchen Song, Yuan Wan, Yuxuan Wang.
