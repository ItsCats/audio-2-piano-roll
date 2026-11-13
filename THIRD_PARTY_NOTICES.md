# Third-party notices

Piano2Vision's own code is Copyright (C) 2026 Jack Anderson and licensed under the GNU Affero General Public
License, version 3 or later; the homr sheet-music reader is version 3 only (see [LICENSE](LICENSE)). In SPDX
terms the repository is `AGPL-3.0-or-later AND AGPL-3.0-only`: the files written for Piano2Vision are
`AGPL-3.0-or-later`, the port of homr in `src/lib/omr/homr/` and homr's models in `public/models/homr/` are
`AGPL-3.0-only` (each file's first line says which), so the app as a whole can be passed on under version 3 of
the AGPL only. Source code: <https://github.com/ItsCats/audio-2-piano-roll>.

homr's transcription model was partly trained on Camera-PrIMuS, a dataset whose published copy is licensed for
non-commercial use only (row below). Piano2Vision is free and non-commercial; keep it that way while it ships
these models, or check homr's [license FAQ](https://github.com/liebharc/homr/blob/main/LICENSE_FAQ.md) first.

The parts below were made by other people and keep their own licenses. Being bundled with Piano2Vision does not
change their license. The in-app Credits page (`src/lib/credits.ts`) lists the same works for users.

## 1. Files in this repository

| Path | Work | Copyright / author | License | Changes |
| --- | --- | --- | --- | --- |
| `public/models/basic-pitch/` (`model.json`, `group1-shard1of1.bin`) | Basic Pitch TF.js model, from npm `@spotify/basic-pitch` 1.0.1 | Copyright 2022 Spotify AB | Apache-2.0 ([LICENSE](public/models/basic-pitch/LICENSE), [README](public/models/basic-pitch/README.md)) | none |
| `src/lib/transcription/noteExtraction.ts`, `constants.ts`, `inference.worker.ts` | note extraction, model constants and windowing derived from [spotify/basic-pitch](https://github.com/spotify/basic-pitch) | Copyright 2022 Spotify AB; changes by the Piano2Vision authors | Apache-2.0 (the derived parts) and AGPL-3.0-or-later (the Piano2Vision changes) | rewritten in TypeScript; each file says so in its header |
| `public/models/piano-specialist/` | note model of "High-resolution Piano Transcription" (Kong et al., ByteDance), checkpoint from [Zenodo record 4034264](https://zenodo.org/records/4034264) | Qiuqiang Kong et al. | weights CC BY 4.0; model code MIT / Apache-2.0 ([LICENSE](public/models/piano-specialist/LICENSE), [README](public/models/piano-specialist/README.md)) | converted to ONNX, float16 weights, pedal model left out, split into 5 files |
| `src/lib/pianoSpecialist/postprocess.ts` | port of `RegressionPostProcessor` from piano_transcription_inference 0.0.6 | Qiuqiang Kong | MIT (text in `public/models/piano-specialist/LICENSE`) | rewritten in TypeScript; see its header |
| `public/models/scnet/scnet.int8.onnx` | [SCNet](https://github.com/starrytong/SCNet) source-separation model (MUSDB18-HQ checkpoint via ZFTurbo's Music-Source-Separation-Training), int8 ONNX export by [audiojs](https://huggingface.co/audiojs/scnet) | Copyright (c) 2024 starrytong | MIT ([LICENSE](public/models/scnet/LICENSE), [README](public/models/scnet/README.md); redistribution of converted weights confirmed in [starrytong/SCNet#35](https://github.com/starrytong/SCNet/issues/35)) | none (served as published by audiojs) |
| `src/lib/separation/dsp.ts` | STFT and segmenting written to match SCNet's preprocessing and the `demix()` procedure of [ZFTurbo/Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training) (MIT) | Piano2Vision authors | AGPL-3.0-or-later | own implementation, credited for the method |
| `public/models/crepe/crepe-tiny.onnx` | CREPE "tiny" pitch model ([marl/crepe](https://github.com/marl/crepe)), PyTorch weights from torchcrepe 0.0.24 | Copyright (c) 2018 Jong Wook Kim; Copyright (c) 2020 Max Morrison | MIT ([LICENSE](public/models/crepe/LICENSE), [README](public/models/crepe/README.md)) | converted to ONNX |
| `public/models/omr/` (`smt-camera-grandstaff/*.bin`, `vocab.json`) | Sheet Music Transformer checkpoint [antoniorv6/smt-camera-grandstaff](https://huggingface.co/antoniorv6/smt-camera-grandstaff) (Ríos-Vila, Calvo-Zaragoza, Paquet, ICDAR 2024) | the SMT authors | MIT ([LICENSE](public/models/omr/LICENSE), [README](public/models/omr/README.md)); training data GrandStaff / Camera-GrandStaff (not shipped) | converted to ONNX (encoder + decoder with key/value cache), 8-bit weights, split into 3 files |
| `src/lib/omr/homr/` | TypeScript port of the inference pipeline of [homr](https://github.com/liebharc/homr) 0.7.1 (optical music recognition; the "Accurate reader") | homr: Christian Liebhardt and the homr contributors; port: Copyright the Piano2Vision contributors, 2026 | AGPL-3.0-only (the ported files; the new files `index.ts`, `support.ts`, `worker.ts`, `protocol.ts`, `page.ts`, `xml.ts`, `fp16w.ts`, `manifest.ts` are AGPL-3.0-or-later); per-file SPDX lines, see [its README](src/lib/omr/homr/README.md) | ported from Python module by module (each file names the homr module it follows and says it was modified); title recognition (OCR) left out; page corners, progress, low-memory mode and size limits added |
| `public/models/homr/` (`segnet.fp16w.*.bin`, `encoder.int8.*.bin`, `decoder.int8.*.bin`) | homr's segmentation, transformer encoder and decoder networks, from its release [onnx_checkpoints](https://github.com/liebharc/homr/releases/tag/onnx_checkpoints) | the homr contributors | AGPL-3.0-only ([LICENSE](public/models/homr/LICENSE), [README](public/models/homr/README.md)). Training data (not shipped): DeepScoresV2 (CC BY 4.0), OpenScore Lieder and String Quartets (CC0), GrandStaff, **Camera-PrIMuS (CC BY-NC 4.0 on its Hugging Face copy: non-commercial use only)**, PDMX (public-domain subset), MuseTrainer library | segmentation weights stored as float16, encoder with 8-bit weights, split into 11 files; made by `tests/homr/convert_models.py` and `tests/homr/package_models.py` (part of the corresponding source) |
| `src/lib/omr/homr/musicxml.ts` (page joining) | [relieur](https://github.com/papoteur-mga/relieur), via homr's `relieur.py` | Papoteur and contributors | Apache-2.0 (no NOTICE file upstream) | ported to TypeScript with homr's MusicXML writer |
| `src/lib/omr/homr/geom.ts`, `subdiv2d.ts`, `cv.ts` | functions of [OpenCV](https://github.com/opencv/opencv) 4.x imgproc that homr calls (contours, convex hulls, rotated boxes, ellipse fitting, Subdiv2D, polygon filling, CLAHE, resizing, morphology, blurring, warpAffine) | Intel Corporation, Willow Garage, NVIDIA, Itseez, Advanced Micro Devices and other OpenCV contributors | BSD-3-Clause and Apache-2.0 ([LICENSE-OpenCV.txt](src/lib/omr/homr/LICENSE-OpenCV.txt)) | algorithms rewritten in TypeScript (no OpenCV code is shipped) |
| `src/lib/omr/homr/cv.ts` (bicubic resize) | [Pillow](https://github.com/python-pillow/Pillow)'s bicubic resampling | Secret Labs AB, Fredrik Lundh, Jeffrey A. Clark and contributors | MIT-CMU ([LICENSE-Pillow.txt](src/lib/omr/homr/LICENSE-Pillow.txt)) | rewritten in TypeScript |
| `public/pdfjs/wasm/` (`jbig2.wasm`, `openjpeg.wasm`, `qcms_bg.wasm`) | image decoders shipped with pdfjs-dist 6.4.299 | PDFium authors; OpenJPEG authors; qcms authors; Mozilla | BSD-3-Clause / Apache-2.0, BSD-2-Clause, MIT (license files next to them) | none |
| `public/samples/grand/` | Salamander Grand Piano V3 | Alexander Holm | CC BY 3.0 ([LICENSE](public/samples/LICENSE), [README](public/samples/README.md)) | 5 of 16 velocity layers, trimmed, faded, MP3 |
| `public/samples/upright/` | Upright Piano KW (FreePats) | FreePats project | CC0 1.0 ([LICENSE](public/samples/LICENSE), [README](public/samples/README.md)) | one of 2 velocity layers, trimmed, faded, MP3 |
| `public/favicon.svg`, icons, decal patterns, title-page ornaments | original work (`scripts/make-icons.mjs` and the renderer code) | Piano2Vision authors | AGPL-3.0-or-later | – |

## 2. npm packages bundled into the built site

These are not stored in this repository; `npm install` downloads them and `npm run build` bundles them into
`dist/`. The build also writes `dist/THIRD_PARTY_LICENSES.txt` (by `scripts/third-party-licenses.ts`), which
holds the license text of every package below, so the deployed site carries the notices.

**Permissive licenses** (MIT, ISC, BSD-3-Clause, Apache-2.0, MIT AND Zlib):
react, react-dom, scheduler, react-router, react-router-dom, cookie, set-cookie-parser (MIT); zustand (MIT);
idb (ISC); lucide-react (ISC); @tonejs/midi, midi-file (MIT); fflate (MIT); jspdf with @babel/runtime, fast-png,
iobuffer (MIT) and pako (MIT AND Zlib); svg2pdf.js with svgpath, cssesc, specificity, font-family-papandreou
(MIT); opensheetmusicdisplay (BSD-3-Clause, Copyright 2019 PhonicScore), whose build includes vexflow,
loglevel, typescript-collections (MIT) and jszip (dual MIT or GPL-3.0-or-later; used under MIT);
onnxruntime-web with onnxruntime-common (MIT, Copyright (c) Microsoft Corporation; third-party notices of the
ONNX Runtime WebAssembly build: <https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt>);
@tensorflow/tfjs-core, -converter, -backend-cpu, -backend-webgl, -backend-wasm 4.22 (Apache-2.0, Copyright
Google LLC) with long (Apache-2.0) and seedrandom (MIT); array-flatten (MIT).

**Weak copyleft:**

- mediabunny 1.65 (MPL-2.0, by Vanilagy): used unmodified. Source: <https://github.com/Vanilagy/mediabunny>.
- @mediabunny/aac-encoder 1.65 (MPL-2.0): its WebAssembly contains FFmpeg's AAC encoder (libavcodec and
  libavutil), licensed under the GNU LGPL 2.1 or later, built without GPL, version 3 or nonfree parts, from FFmpeg
  commit [`60a2818f76dcd1fee3155b1791304af104a0fc1b`](https://github.com/FFmpeg/FFmpeg/commit/60a2818f76dcd1fee3155b1791304af104a0fc1b),
  unmodified. The build steps are in the package README (<https://github.com/Vanilagy/mediabunny>,
  `packages/aac-encoder`); FFmpeg's license files ship in the package (`licenses/ffmpeg`) and in
  `dist/THIRD_PARTY_LICENSES.txt`. You may replace the encoder with a modified FFmpeg build by rebuilding the
  package as described there.

**Fonts** (SIL Open Font License 1.1, packaged by Fontsource; the OFL text is in `dist/THIRD_PARTY_LICENSES.txt`):

| Font | Copyright |
| --- | --- |
| Inter | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) |
| JetBrains Mono | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |
| Cinzel | Copyright 2020 The Cinzel Project Authors (https://github.com/NDISCOVER/Cinzel) |
| Playfair Display | Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display" |
| Cormorant Garamond | Copyright 2015 The Cormorant Project Authors (github.com/CatharsisFonts/Cormorant) |
| EB Garamond | Copyright 2017 The EB Garamond Project Authors (https://github.com/octaviopardo/EBGaramond12) |
| Great Vibes | Copyright 2010 The Great Vibes Pro Project Authors (https://github.com/googlefonts/great-vibes) |

**Not bundled:** jsPDF's optional helpers html2canvas, canvg and dompurify are replaced by a stub
(`src/lib/sheet/stub.ts`). Build and test tools (vite, rolldown, tailwindcss, lightningcss, typescript, vitest,
playwright, @spotify/basic-pitch, @tensorflow/tfjs 3) are used only to build or test and are not part of the
site.

## 3. Optional processing server (`server/`)

Nothing is vendored; `server/requirements*.txt` lists the packages, installed with pip: fastapi (MIT), starlette
(BSD-3-Clause), pydantic (MIT), uvicorn[standard] (BSD-3-Clause, with its optional extras), python-multipart
(Apache-2.0), numpy (BSD-3-Clause), yt-dlp (Unlicense), onnxruntime (MIT), and for tests pytest (MIT) and httpx
(BSD-3-Clause). The Docker image adds Debian's `ffmpeg` package as a separate program (LGPL/GPL, Debian build).
The SCNet model is downloaded at build or first use (see section 1). Because the server is AGPL-licensed, its
root response and `/api/health` link to its source code (`SOURCE_CODE_URL`).

## 4. Used only to measure accuracy (not included, not distributed)

| Work | License | Note |
| --- | --- | --- |
| [MAESTRO v3](https://magenta.tensorflow.org/datasets/maestro) (Google Magenta) | CC BY-NC-SA 4.0 | concert performances with exact MIDI; numbers on the Accuracy page come from them. No MAESTRO files are in this repository. |
| [ASAP dataset](https://github.com/fosfrancesco/asap-dataset) | CC BY-NC-SA 4.0 | an aligned score, used for an earlier measurement |
| [Musopen](https://musopen.org) | CC0 | one public-domain solo piano recording |
| High-resolution Piano Transcription (PyTorch package `piano_transcription_inference`) | MIT; weights CC BY 4.0 | reference runs |
| [Demucs](https://github.com/facebookresearch/demucs) | MIT code; weights research-only | reference stems only; never shipped |
| CREPE / torchcrepe, mir_eval, librosa | MIT; MIT; ISC | analysis tools |
| Other test songs and recordings | copyrighted | used privately for measuring only; never committed, copied into the app or shared |
