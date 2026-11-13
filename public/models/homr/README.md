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

Total download 93.2 MB. Each piece (`*.partN.bin`) is under Netlify's 10 MB per file; the sizes and
sha256 of the joined files are in `src/lib/omr/homr/manifest.ts`. Made with `tests/homr/convert_models.py`
and `tests/homr/package_models.py` (onnx 1.23.2, onnxruntime 1.31.1).

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
articulation (an accent; staccato instead of staccatissimo). Their class maps and staff images are identical
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

**Memory**: the browser's resident memory grew by 1,010 MB while reading the first page (model download,
the three sessions, one page) and by 390 MB for later pages with the sessions kept; the worker is
terminated after the job on phones and small-memory devices and after a minute idle elsewhere (a WASM
memory never shrinks while its worker lives). Pages are sent to the worker one at a time.
