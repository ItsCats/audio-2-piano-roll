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
| strong piano transcriber (eval aid only) | `pti_transcribe.py CKPT WORK/refs/pti FILES...` | `refs/pti/<id>.pti.json` |
| score-informed snapping | `snap_ref.py ALIGNED.json PTI.json OUT.json [--truth PERF.midi]` | `refs/snapped/<id>.json` |
| metric sanity checks | `sanity.py REF AUDIO [VOCAL.f0.npz] [--no-proxies]` | stdout, `$SANITY_OUT` |
| posterior dump | `node tests/accuracy/transcribe.mjs --dump-posteriors WORK/posteriors WORK/maestro/m-*.wav` | `posteriors/<id>.{frames.u8,onsets.u8,rms.f32,post.json}` |
| synthetic e2e posteriors | `node tests/accuracy/sweep_extraction.e2e.mjs --dump WORK/posteriors` | `posteriors/e2e-*` |
| detection sweep (no model) | `node tests/accuracy/sweep_extraction.mjs --post WORK/posteriors --ref WORK/maestro --configs tests/accuracy/sweep_extraction.configs.mjs [--json OUT]` | stdout / JSON |
| evaluation | `evaluate.py --work WORK --out WORK/eval/x FILES...` (config: `songs.json`) | `eval/x.json` |
| Easy RH source analysis | `rh_source.py WORK OUT.json ids...` (needs the app run on stems) | JSON |
| report | `make_report.py EVAL.json OUT.md --refs ... --sanity ... --prepend ... --append ...` | Markdown |
| separated app path (in-browser SCNet + vocal melody) | `node tests/accuracy/transcribe.mjs --separate --out WORK/sep --presets mix FILES...` (~2.5 GB, one run at a time) | `sep/<id>.<preset>.json` |
| offline melody / arrangement regeneration from saved runs with posteriors | `node tests/accuracy/melody_regen.mjs [--keep-base] OUTDIR RUN.json ...` (env `MELODY_OPTS` = JSON MelodyOptions overrides) | `OUTDIR/<id>.json` (base/easy/medium/hard/vocalNotes/speech) |
| melody evaluation | `melody_eval.py --work WORK [--out OUT.json] RUN.json ...` | Easy/Medium RH, melody line and ceiling as RPA/RCA/OA/OA-chroma; RPA/RCA on stable-periodicity frames; RH register, LH clearance, speech-section stats, Easy LH bass RCA |
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

## Notes on the separated path

- Easy/Medium move the sung line by octaves on purpose (median E4–E5, at least 5 semitones above the
  left hand), so score them with RCA / OA-chroma; RPA is only meaningful for Hard and the melody line.
- Separated songs store the drums stem's onset envelope with the posteriors (`StoredPosteriors.drums`,
  8-bit at 100 fps, `separation/dsp.ts drumOnsetEnvelope`). The drum-hit false-note filter
  (`music/cleanup.ts DRUM_HIT_RULE`) is off by default because it lowered bass RCA; flip `enabled` to
  re-measure.
- `sweep_extraction.mjs` passes the frame posteriors to `cleanNotes`, so it scores the bass re-strike
  rule (`RESTRIKE`) exactly as the app applies it.
- The CREPE-tiny tracker (`src/lib/pitch`) is built and measured but not wired into the app: against
  the independent pYIN-on-Demucs reference its gain was small and mixed (+0.02 RPA mean, worse on one
  song of five).
