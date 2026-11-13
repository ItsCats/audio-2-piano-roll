# Sheet-music reader: homr models (AGPL-3.0)

Piano2Vision reads printed sheet music from PDFs and photos with a TypeScript port of **homr**
(https://github.com/liebharc/homr) by Christian Liebhardt and the homr contributors. homr's code and
its model weights are licensed under the **GNU Affero General Public License v3.0** — see
[LICENSE](LICENSE) (homr's licence file, unchanged). The files here are homr's networks; the port of its
program is `src/lib/omr/homr/` (see the README there for what was changed). Both are published with this
app's source code under the same licence.

The models are downloaded only when someone first reads a PDF or a photo, then kept in the browser's
Cache API (`src/lib/omr/homr/worker.ts`, sha256-checked).

## Files

| Network | Shipped file (joined from the pieces) | From homr 0.7.1 | Change |
|---|---|---|---|
| Segmentation (staff lines, noteheads, stems, clefs, other symbols) | `segnet.fp16w.onnx`, 28,682,926 bytes, 4 pieces | `segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx` (57,311,361 bytes) | weights stored as float16 and cast to float32 inside the graph |
| Transformer encoder | `encoder.int8.onnx`, 17,142,614 bytes, 2 pieces | `encoder_pytorch_model_509-2293bba14bfea47d9d28411339362af15fce4c31.onnx` (52,861,122 bytes) | onnxruntime dynamic quantisation of MatMul / Gemm weights to int8 |
| Transformer decoder (with key/value cache) | `decoder.int8.onnx`, 47,356,003 bytes, 5 pieces | `decoder_pytorch_model_509-2293bba14bfea47d9d28411339362af15fce4c31.onnx` | none (homr ships it with int8 weights already) |

**Where the originals come from:** homr's release `onnx_checkpoints`,
https://github.com/liebharc/homr/releases/tag/onnx_checkpoints (the files homr 0.7.1 downloads on first
run, from `https://github.com/liebharc/homr/releases/download/onnx_checkpoints/`; homr's
`homr/main.py` `download_weights`). The port follows homr 0.7.1 as published on PyPI (source:
https://github.com/liebharc/homr). homr licenses them under the AGPL version 3 only (`AGPL-3.0` in its
`pyproject.toml`, no "or any later version").

Total download 93.2 MB. Each piece (`*.partN.bin`) is under Netlify's 10 MB per file; the sizes and
sha256 of the joined files are in `src/lib/omr/homr/manifest.ts`. Made with `tests/homr/convert_models.py`
and `tests/homr/package_models.py` (onnx 1.23.2, onnxruntime 1.31.1); these scripts are part of the
corresponding source of the converted files. In the browser the float16 weights are expanded back to
float32 before onnxruntime builds the session (`src/lib/omr/homr/fp16w.ts`): the same numbers as the
in-graph casts, but a lower peak of memory (the casts' constant folding briefly needs both copies).

Why these variants (OMR test set below, Python homr, notes F1 per category):

| Models | clean | real engraved | photos | real photos | segmentation time |
|---|---|---|---|---|---|
| float32 (homr as published) | 1.000 | 0.984 | 1.000 | 0.988 | 1x |
| segmentation float16 weights + encoder int8 (shipped) | 1.000 | 0.984 | 1.000 | 0.987 | 1x |
| segmentation int8 + encoder int8 | 1.000 | 0.984 | 1.000 | 0.987 | 4.6x slower in WASM (ConvInteger) |

The int8 segmentation would save 14 MB but its integer convolutions are 4.6 times slower in
onnxruntime-web (113 s instead of 24 s per page, Node, 3 threads), so the float16-weight file is shipped.

## Training data (from homr's LICENSE_FAQ.md, checked by homr's authors October 2026)

| Network | Training data | Licence as stated by the source |
|---|---|---|
| Segmentation | DeepScoresV2 | CC BY 4.0 |
| Transformer | OpenScore Lieder, OpenScore String Quartets | CC0 |
| | GrandStaff | not stated at the source; MIT for the Hugging Face copy |
| | **Camera-PrIMuS** | not stated at the source; **CC BY-NC 4.0 (non-commercial)** for the Hugging Face copy |
| | PDMX (`no_license_conflict` subset) | CC BY 4.0 (dataset), public-domain scores |
| | MuseTrainer library | public domain (repository description) |

The transformer was partly trained on Camera-PrIMuS, which may only be used non-commercially. Whether
that carries over to the weights is an open legal question (homr's FAQ); Piano2Vision is free and
non-commercial. Anyone reusing these files should read https://github.com/liebharc/homr/blob/main/LICENSE_FAQ.md.

## Measurements

Measured 2026-11-13 on the OMR research test set (kept outside the repository): 12 made-up piano pages
engraved with OSMD with exact answer keys ("clean"), the same as synthetic phone photos ("photos"), and 6
public-domain Mutopia pages (two Schumann-era études, three Bach chorales) as engraved pages ("real
engraved") and photos ("real photos"), compared with their MIDI files. Notes F1: chords aligned in order, a
note counts when its pitch is in the aligned chord. Photos are given to homr uncropped (homr crops to the
paper itself).

**Port vs Python homr** (TypeScript port with the shipped models in onnxruntime-web, Node; Python homr
0.7.1 with the same model files and with the original float32 files):

| | clean | real engraved | photos | real photos |
|---|---|---|---|---|
| notes F1, TypeScript port (shipped models) | 1.000 | 0.984 | 1.000 | 0.987 |
| notes F1, Python homr, same models | 1.000 | 0.984 | 1.000 | 0.987 |
| notes F1, Python homr, float32 models | 1.000 | 0.984 | 1.000 | 0.988 |
| agreement of the port's notes with Python homr (same models), notes F1 | 1.000 | 1.000 | 1.000 | 1.000 |
| pages with identical MusicXML (same models) | 12/12 | 6/6 | 12/12 | 4/6 |

The two real photos whose MusicXML is not identical have the same notes and rhythm; each differs in one
articulation (an accent; staccato instead of staccatissimo). On harder input the same cause can also
change a rhythm: on a real photo scaled down to 900 px wide (not in the test set), one staff came out as
eighths in the port and as a triplet group in Python homr (notes F1 against the answer key 0.998 vs 0.996,
rhythm 0.986 vs 0.863, so the port was not worse there); with the float32 encoder both agree. So the port
and Python homr agree on the notes, but with the int8 encoder their output is not guaranteed identical;
an encoder with float16 weights (+9 MB) would make it so. Their class maps and staff images are identical
to Python homr's; the difference comes from the int8 encoder: onnxruntime-web's WASM kernels and native
onnxruntime quantize the activations with different rounding, so the two encoder outputs differ by up to
0.25 (the float32 encoder agrees to 1e-4), and the decoder's articulation choice on those two notes had a
small margin (0.17 and 0.38 logits). Fed Python's encoder output, the port decodes the same symbols. Neither
output is closer to the float32 encoder's (RMS error 0.051 for both). Headless Chromium (production build,
3 threads, 1 thread, CPU-capped) produces the same MusicXML as Node.
`tests/unit/homr/pipeline.test.ts` checks the image analysis step by step against Python homr's
intermediate results on two generated pages.

**Photos with page corners** (as after the app's corner screen: the photo is straightened to the four
corners first, `src/lib/omr/homr/page.ts`, then homr's own steps run): notes F1 0.985 on the synthetic photos
(one page lost part of a staff; 1.000 uncropped) and 0.993 on the real photos (0.987 uncropped).

**Speed** (headless Chromium, `tests/e2e/homr-bench.mjs`, models from the cache, on a 4-core machine that
another browser job was using at the same time, so these are upper bounds):

| page | systems | 3 threads (cross-origin isolated) | 1 thread |
|---|---|---|---|
| clean (made-up) | 2 | 41 s* | 48 s |
| real engraved, Bach chorale | 3 | 32 s | 56 s |
| real engraved, étude | 5 | 59 s | 80 s |
| real photo, Bach chorale | 3 | 46 s* | 60 s |
| real photo, étude | 5 | 76 s* | 80 s |

\* measured before the decoder was set to one thread (the two engraved pages took 47 s and 73 s then).

Segmentation takes 17–35 s of that (54 windows of 320 x 320 for a 1920 px wide page), the decoder about
6 s per system. The decoder session runs on one thread: its one-token steps lose time to thread
synchronisation (30 s instead of 41 s for the étude page with three threads). Python homr on the CPU
(4 threads) takes 9–13 s per page.

**Whole test set, production build** (`tests/e2e/homr-prod.mjs`: `npm run build` output served with
netlify.toml's headers, page images decoded in the page; 2026-11-13, while other jobs' browsers used about
2 of the 4 cores, so upper bounds): median 73 s per page with 3 threads (cross-origin isolated) and 66 s
with 1 thread, about 25 s per system either way; no CSP violations. With the whole browser capped at one
core (four cores at a quarter speed, a phone estimate): 123–141 s for pages of 2–3 systems and 188–274 s for
5 systems. Memory: the browser's PSS grew by about 1,000–1,080 MB on the first page and by at most
850 MB on later pages; the peak was 1.7 GB for the whole browser. The first page downloads 108 MB
(93 MB models, 15 MB onnxruntime WASM shared with the app's other readers).

**Memory** (re-measured 2026-11-13 after the memory changes, production build, headless Chromium,
models from the cache except on the first page; other jobs used 0–2 of the 4 cores):

| mode | first page: whole-browser PSS | tab's renderer process peak (idle: ~100 MB) | after the job |
|---|---|---|---|
| desktop, 3 threads, networks kept loaded | +970 MB | 975–1,100 MB | ~900–1,100 MB until the idle worker ends (1 min) |
| desktop, 1 thread, networks kept loaded | +1,035 MB | 1,047–1,089 MB | same |
| low-memory mode (phones), 1 thread | +1,079 MB (with the download) | 928–1,025 MB | the worker ends at once |
| low-memory mode, 3 threads | +972 MB (with the download) | 867–979 MB | the worker ends at once |

What changed: the float16 weights are expanded before onnxruntime builds the segmentation session
(`src/lib/omr/homr/fp16w.ts`; the segmentation step's peak in Node fell from +425–449 MB to +288 MB,
identical outputs), and in low-memory mode (default on phones, tablets and devices reporting 4 GB or
less, and for the import screen's retry after a crash) only the current step's networks exist: the
segmentation session is released before the encoder and decoder are created, segmentation runs one
320 px window at a time, one WASM thread is used, and the worker ends right after the job. In Node that
lowers a page's peak only from +712 to +627–698 MB, and in Chromium the renderer's peak by about 2–15 %,
because the encoder + decoder step alone needs ~500 MB of WASM memory (session creation and the
decoder's key/value cache) and the WASM heap does not shrink. So a phone tab needs roughly 1 GB more
while reading, which is close to what iOS allows a Safari tab; not measured on a real phone yet. The
reader also refuses more than 5 pages per job on phones and tablets (20 elsewhere), scales input images
down to 4000 px on the longer side (a 48-megapixel photo took 40 s and 2 GB in the paper-cropping step
before), and does not read images more than three times taller than wide (a long screenshot would have
become a 1920 x 16,000 px page). Pages are sent to the worker one at a time.

The changes do not alter the results: on 8 test pages (two per category) the production build gives
byte-identical MusicXML before and after them, with all three networks kept loaded and in low-memory mode;
the paper cropping gives identical crops and pixels on all 18 photo and real pages.
**Held-out pieces, compared with the Quick reader** (2026-11-13, production build, `tests/e2e/homr-prod.mjs`,
3 threads, corners given for the photos): the 16 pieces an independent review generated for the Sheet Music
Transformer reader (`public/models/omr/README.md`, "Held-out re-measurement"; keys, meters and textures the
test set above lacks, engraved with Verovio), scored with the same scorer (`tests/e2e/omrScore.ts`, notes
via the app's MusicXML import), mean over pieces:

| test set | homr notes / rhythm | Sheet Music Transformer notes / rhythm |
|---|---|---|
| new pieces, Verovio page images | 0.989 / 0.989 | 0.873 / 0.780 |
| new pieces, simulated phone photos, corners set | 0.989 / 0.989 | 0.869 / 0.768 |

15 of the 16 pieces came out perfect in both rows; the ledger-line piece (notes up to five ledger lines and
an 8va passage) scored 0.843. 35–200 s per page (the slow ones while two other browser jobs shared the
4 cores; 35–41 s on an idle machine).
