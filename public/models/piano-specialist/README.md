# Piano specialist: high-resolution piano transcription (ONNX, float16 weights)

The note model of ByteDance's "High-resolution Piano Transcription with Pedals by Regressing Onset and
Offset Times" (Kong et al., 2021). Piano2Vision runs it in the browser (onnxruntime-web, WASM) for the
import option "High-accuracy piano model". Code: `src/lib/pianoSpecialist/` (worker, segmenting)
and `src/lib/pianoSpecialist/postprocess.ts` (the package's note post-processing in TypeScript).
It was trained on solo piano recordings (MAESTRO) only, so it does not help with vocals, drums or band mixes.

| | |
|---|---|
| Files | `piano-note.fp16.part1.bin` … `part5.bin` (8,208,903 bytes each, the last 8,208,900): one ONNX file split into five consecutive pieces because Netlify recommends at most 10 MB per deployed file. `cat piano-note.fp16.part*.bin > piano-note.fp16.onnx` restores it; the worker fetches the pieces, joins them, checks the sha256 and keeps the whole file in the Cache API |
| Joined file | `piano-note.fp16.onnx`, 41,044,512 bytes |
| SHA-256 (joined) | `8fd48c407cd15dd88b98c3803b5f037291a93003767ed590dc647fff21e03c59` |
| Source checkpoint | `CRNN_note_F1=0.9677_pedal_F1=0.9186.pth`, Zenodo record 4034264 (https://zenodo.org/records/4034264, DOI 10.5281/zenodo.4034264), 171,966,578 bytes, md5 `22b961b77c1878239fec963362097045` (as listed by Zenodo), sha256 `c3fa9730725bf4a762f1c14bc80cd5986eacda01b026f5a4a2525cd607876141` |
| Model code | `piano_transcription_inference` 0.0.6 (PyPI, MIT, Qiuqiang Kong): `Regress_onset_offset_frame_velocity_CRNN`; front end from torchlibrosa 0.1.0 (MIT). Training code: https://github.com/bytedance/piano_transcription (Apache-2.0 per its README; no code from it is shipped) |
| Export | `server/.venv/bin/python tests/accuracy/pti_export.py CKPT OUT/piano-note.fp16.onnx --split 5` (torch 2.15 `torch.onnx.export`, opset 17, then float16 storage; ~5 min). Parity: `tests/accuracy/pti_export_check.py`, browser: `tests/accuracy/pti_export_browser.mjs` |
| License | weights CC BY 4.0, architecture code MIT; see [LICENSE](LICENSE) |

## What was changed

- Only the **note model** of the checkpoint is exported; the sustain-pedal model is left out.
- **Float16 storage**: every float initializer with 1024 or more values (20.4 M values) is stored as float16 and
  cast back to float32 by a `Cast` node inside the graph (onnxruntime folds the casts when the session is created),
  so the WASM backend runs ordinary float32 kernels. The 18,148 values in small initializers (biases, batch-norm
  statistics) stay float32. Half the size of the float32 export (98.7 MB). (int8 dynamic quantisation was tried
  earlier and broke the GRUs; it was also slower. Don't.)
- **STFT basis computed in the graph**: torchlibrosa's 2 × 1025 × 2048 windowed DFT basis (4.2 M values, 8.4 MB
  even as float16) is rebuilt from integers, `cos/-sin(2π · ((k·n) mod 2048) / 2048)` times the periodic Hann
  window, in float32 (max abs difference to torchlibrosa's 4.2e-7). The mel filterbank is stored as float16.

## Graph

Input `audio` [1, 160000] float32: 10 s of 16 kHz mono (the package's `segment_samples`). Outputs `frame`,
`onset`, `offset`, `velocity`, each [1, 1001, 88] float32 at 100 frames/s, pitch 0 = MIDI 21 (`onset` / `offset`
are the regression outputs `reg_onset_output` / `reg_offset_output`). The log-mel front end (centered STFT with
reflect padding, n_fft 2048, hop 160, 229 mel bins 30–8000 Hz, power to dB) is inside the graph. Segmenting
follows `PianoTranscription.transcribe`: zero-pad to a multiple of 10 s, windows every 5 s, drop each window's
last frame and keep the middle halves (all 1001 frames for a single window), `src/lib/pianoSpecialist/protocol.ts`.

## Measurements (2026-11-12)

Parity against the float32 PyTorch model on the same 16 kHz input (ffmpeg decode), MAESTRO recordings with the
package's own segmenting, post-processed by the package's `RegressionPostProcessor`:

| input | output max abs diff (frame / onset / offset / velocity) | thresholded agreement (frame > 0.1, onset/offset > 0.3) | notes |
|---|---|---|---|
| Chopin Nocturne Op. 15/1, 30 s from 1:00 | 0.0042 / 0.0007 / 0.0038 / 0.0003 | ≥ 0.99998 | 173 = 173, all matched; onsets within 0.1 ms, offsets within 10 ms, 1 velocity off by 1 |
| Mozart K. 280/1, 30 s from 0:30 | 0.0010 / 0.0004 / 0.0005 / 0.0002 | 1.0 | 270 = 270, onsets identical, offsets within 25 ms, 1 velocity ±1 |
| Liszt Waldesrauschen, 30 s from 1:30 | 0.0065 / 0.0007 / 0.0030 / 0.0003 | ≥ 0.99992 | 453 = 453, onsets within 0.1 ms, offsets within 10 ms |
| Mozart K. 280/1, whole piece (3:14, 39 windows) | 0.0026 / 0.0010 / 0.0019 / 0.0003 | ≥ 0.999999 | 1814 = 1814, onsets within 0.11 ms, offsets within 25 ms (a frame or two), 3 velocities ±1 |

The float32 ONNX export alone differs from PyTorch by ≤ 2e-5 (all notes identical), so the differences above are
the float16 rounding of the weights. The browser (onnxruntime-web 1.31.1 WASM, 1 and 3 threads) matches
onnxruntime CPU in Python on the same file within 5e-5 on every output, with the same notes.

Browser speed and memory, headless Chromium on a shared 4-core x86 box (load average 1.5–4 from other jobs):

| | 1 thread | 3 threads |
|---|---|---|
| per 10 s window | ~7.7 s | 3.0–4.2 s |
| per minute of audio (12 windows; 3:14 piece) | 94 s | 36 s |
| 2 threads | ~4.2 s per window | |
| tab memory (RSS of the whole browser, session + inference) | +540 MB | +550 MB |

Model load: download from a local server + sha256 check ~0.5 s (on the open internet the 41 MB download depends
on the connection, ~7 s at 50 Mbit/s), Cache API read + check ~0.1 s, session compile 0.4–0.8 s. Peak RSS of the
parity harness page was ~+680 MB for a 30 s excerpt and up to ~+970 MB for the 3:14 piece (the harness also holds
the Python reference maps). Without cross-origin isolation (Safari; the YouTube import route) only 1 thread runs.

Note-level accuracy of the Python reference against MAESTRO's exact performance MIDI (onset F1 at 50 ms): Liszt
0.94, Nocturne Op. 15/1 0.97, Mozart K. 280/1 0.99, Ballade No. 1 0.98 — the Ballade recording is in MAESTRO's
**train** split, so that one number is optimistic.

## Citation

```bibtex
@article{kong2021highresolution,
  title   = {High-resolution Piano Transcription with Pedals by Regressing Onset and Offset Times},
  author  = {Kong, Qiuqiang and Li, Bochen and Song, Xuchen and Wan, Yuan and Wang, Yuxuan},
  journal = {IEEE/ACM Transactions on Audio, Speech, and Language Processing},
  volume  = {29},
  pages   = {3707--3717},
  year    = {2021},
  doi     = {10.1109/TASLP.2021.3121991}
}
@misc{kong2020checkpoint,
  title     = {High-resolution Piano Transcription with Pedals by Regressing Onsets and Offsets Times (trained model)},
  author    = {Kong, Qiuqiang},
  publisher = {Zenodo},
  year      = {2020},
  doi       = {10.5281/zenodo.4034264}
}
```
