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

MEASUREMENTS
