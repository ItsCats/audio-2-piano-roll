# Sheet-music reader (beta): Sheet Music Transformer, ONNX, 8-bit weights

Piano2Vision reads printed piano music from PDFs and photos with the **Sheet Music Transformer (SMT)** of
Antonio Ríos-Vila, Jorge Calvo-Zaragoza and Thierry Paquet (ICDAR 2024, https://github.com/antoniorv6/SMT, MIT).
It runs in the browser (onnxruntime-web 1.31.1, WASM, `src/lib/omr/worker.ts`) and is downloaded only when
someone first reads a PDF or a photo, then kept in the Cache API. One model serves both PDFs and photos.

| | |
|---|---|
| Checkpoint | `antoniorv6/smt-camera-grandstaff` (Hugging Face; fine-tuned on Camera-GrandStaff): `model.safetensors` sha256 `93be49ca62c1d270579648e0c6d596cd239a7f0461c796f647ec0597ac085448`, `config.json` sha256 `de430bd1c38063fd002b93eab623fc467527d5f1167bb4ded067637dbe32d961` |
| Licence | MIT, Copyright (c) 2023 Antonio Ríos-Vila — see [LICENSE](LICENSE) (the repository's licence; the model card also says MIT) |
| Files | `smt-camera-grandstaff/encoder.int8.part1.bin` (= `encoder.int8.onnx`, 6,935,635 bytes) and `decoder.int8.part1.bin` + `part2.bin` (joined: `decoder.int8.onnx`, 16,405,521 bytes), each piece under Netlify's 10 MB per file; `manifest.json` lists sizes and sha256 of the joined files, which `src/lib/omr/models.ts` checks. `vocab.json` (180,872 bytes): token id → bekern token, from the checkpoint's `config.json` |
| Export | `tests/omr/export_smt.py MODEL_DIR OUT_DIR` (torch 2.9.1, onnx 1.23.2, onnxruntime 1.31.1, transformers 4.57.6): the inference path re-implemented in `tests/omr/smt_arch.py` from the upstream MIT code, with a key/value cache; ONNX opset 17; int8 = onnxruntime `quantize_dynamic` (QUInt8 weights) |

## Graphs

- `encoder`: `image` [1, 1, H, W] float32, 0 = ink, 1 = paper (one grand-staff system, staff space ≈ 9.8 px, at
  least 256 px tall) → `cross_k`, `cross_v` [8, 4, N, 64]: the cross-attention keys and values of the 8
  decoder layers (N = H/16 · W/16).
- `decoder`: `token` [1, 1] int64, `pos` [1] int64, `past_k` / `past_v` [8, 4, T, 64], `cross_k`, `cross_v` →
  `logits` [1, 20578], `next_k` / `next_v` [8, 4, T + 1, 64]. Greedy decoding from `<bos>` to `<eos>`, at
  most 1280 steps; the worker also stops a system whose output runs away (far more bar lines than the image
  shows, 32 empty lines in a row, more than 10 spines).

The output is "bekern" (**kern split into tokens with `<b>` line, `<t>` tab and `<s>` space markers);
`src/lib/omr/kern.ts` reads it and `src/lib/omr/musicxml.ts` writes MusicXML for the normal score import.
Page clean-up, staff and system finding (`page.ts`, `staves.ts`) are our own TypeScript, ported from the
research prototype and improved for photos.

## Measurements (2026-11-13)

Research test set (kept outside the repository): 12 made-up piano pages engraved with OSMD with exact
answer keys ("clean"), the same as phone-like photos ("photo": perspective, shadow, blur, noise, JPEG), and 6
public-domain Mutopia pages (two Schumann-era études and three Bach chorales from LilyPond, compared with
their MIDI files) as clean pages and photos ("real"). Notes F1: chords aligned in order, a note counts when
its pitch is in the aligned chord (rhythm mistakes tolerated); rhythm F1 also needs the local timing right.
Photos use the four page corners (as after the corner screen) unless marked "auto".

Whole browser pipeline (this app's code, headless Chromium, 3 WASM threads), notes F1 / rhythm F1:

| model, weights | clean | real (PDF) | photo | real photo | download |
|---|---|---|---|---|---|
| **smt-camera-grandstaff, int8 (shipped)** | **0.926 / 0.82** | **0.799 / 0.56** | **0.909 / 0.81** | **0.756–0.766 / 0.52–0.54** | **23 MB** |
| smt-camera-grandstaff, float32 | 0.931 / 0.83 | 0.801 / 0.58 | 0.903 / 0.80 | 0.776 / 0.56 | 87 MB |
| smt-grandstaff, int8 | 0.878 / 0.78 | 0.806 / 0.58 | 0.875 / 0.77 | 0.775 / 0.55 | 23 MB |
| smt-grandstaff, float32 | 0.890 / 0.80 | 0.797 / 0.55 | 0.879 / 0.77 | 0.788 / 0.55 | 87 MB |
| research prototype (Python, OpenCV), smt-grandstaff float32 | 0.868 / 0.75 | 0.782 / 0.56 | 0.875 / 0.72 | 0.583 / 0.38 | |

8-bit weights cost at most 0.01 notes F1 against float32 (float16 storage was 0.00 in the prototype but twice
the size), and the camera checkpoint read clean pages as well as (made-up pages: better than) the
GrandStaff checkpoint trained for clean pages, so only it is shipped. With automatic corners (no corner
screen) the shipped pipeline reaches 0.83 on the made-up photos and 0.50 on the real photos (two of six get
a wrong corner; the prototype: 0.68 over all photos), so the app lets people adjust the corners.

### Held-out re-measurement after an independent review (2026-11-13)

The numbers above come from the pages the reader was tuned on. An independent review generated 16 new
pieces in code (B / D-flat / A-flat / E-flat major, f# / g / a / c# minor; 6/8, 12/8, 2/4, 2/2; 16th runs,
chorale, ties across bars, triplets, octaves, left hand in treble clef, two voices, pickup, rests, ledger
lines, two pages), engraved them with two programs (Verovio, as PNG and vector PDF; OSMD at non-default
settings) and simulated photos of them. It found that **kern "spacer" lines (only `.`) were each taking a
time step (pieces came out ~20% too long) and that the time-signature correction turned correct 3/4 and 4/4
into wrong meters; both are fixed (src/lib/omr/kern.ts). Shipped pipeline after the fixes, notes F1 /
rhythm F1, app defaults:

| test set | notes / rhythm |
|---|---|
| new pieces, Verovio, vector PDF | 0.883 / 0.806 (was 0.714 rhythm) |
| new pieces, Verovio, page images | 0.873 / 0.780 |
| new pieces, OSMD | 0.896 / 0.827 |
| new pieces, simulated phone photos, corners set | 0.869 / 0.768 |
| new pieces, simulated photos, automatic corners | 0.763 / 0.679 (1 of 16: no music lines found) |
| new pieces, harsh photos (page curl, blur, dim, JPEG q38–50), corners set | 0.318 / 0.185 |
| tuning set: clean / real / photo / real photo | 0.926 / 0.840, 0.798 / 0.588, 0.909 / 0.835, 0.756 / 0.549 |
| tuning set, automatic corners: photo / real photo | 0.834 / 0.742, 0.503 / 0.313 |

Wrong time signatures on the 16 new PDFs: 6 before, 0 after. Known weak spots: notes on many ledger lines
(F1 0.55–0.73 on the ledger-line piece), notes read twice (precision 0.84–0.88 against recall ~0.91),
page curl (the staff finder splits curved systems), and a misread key signature (every sharp / flat a
semitone off). Real phone photos have not been measured; the photo rows are simulations.

Speed and memory (headless Chromium on a shared 4-core x86 box with other jobs running): a dense real page
(4–5 systems, ~1400 model steps) takes 18–28 s with 3 threads and 31–36 s with 1 thread; a page of two
systems 4–8 s. Almost all of it is the token-by-token decoder (~11–19 ms per step). The browser needs
+550 MB (1 thread) to +940 MB (3 threads) at the peak; ~400 MB stays while the model is kept loaded. Phones
run one thread and release the model after each job.

Possible later improvements: pass the cross-attention keys/values as float16 (they are copied into WASM
memory on every decoder step), a better page-corner finder for automatic photos, or another model behind the
same worker protocol (`src/lib/omr/protocol.ts`: system image in, **kern out).

## Citations

```bibtex
@InProceedings{RiosVila:ICDAR:2024,
  author    = {Ríos-Vila, Antonio and Calvo-Zaragoza, Jorge and Paquet, Thierry},
  title     = {Sheet Music Transformer: End-To-End Optical Music Recognition Beyond Monophonic Transcription},
  booktitle = {Document Analysis and Recognition - ICDAR 2024},
  year      = {2024},
  publisher = {Springer Nature Switzerland},
  address   = {Cham},
  pages     = {20--37},
  isbn      = {978-3-031-70552-6}
}
@article{RiosVila:IJDAR:2023,
  author  = {Ríos-Vila, Antonio and Rizo, David and Iñesta, José M. and Calvo-Zaragoza, Jorge},
  title   = {End-to-end optical music recognition for pianoform sheet music},
  journal = {International Journal on Document Analysis and Recognition (IJDAR)},
  year    = {2023}
}
```
