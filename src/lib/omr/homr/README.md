# homr sheet-music reader (TypeScript port)

This directory is derived from **homr** (https://github.com/liebharc/homr), an optical music
recognition program by Christian Liebhardt and the homr contributors, licensed under the
**GNU Affero General Public License v3.0** (AGPL-3.0; licence text: `public/models/homr/LICENSE`).
It is a port of homr 0.7.1's inference pipeline from Python to TypeScript, so it is a modified version
of homr and is itself licensed under the AGPL-3.0. Copyright of the original work: the homr
contributors. Changes: Copyright the Piano2Vision contributors, 2026, also AGPL-3.0.

What was changed (summary, as the AGPL asks modified versions to state):

- Python → TypeScript, module by module (the file headers name the homr module each one ports):
  `geom.ts` / `cv.ts` re-implement the OpenCV and Pillow functions homr calls (no OpenCV.js), `boxes.ts`,
  `staffDetection.ts`, `symbols.ts`, `systemRepair.ts`, `staffImage.ts`, `vocabulary.ts`, `triplets.ts`,
  `musicxml.ts` (homr's MusicXML writer and relieur page joining) and `pipeline.ts` follow homr's
  `main.py` (`process_image` with `--no-title`).
- The networks run with onnxruntime-web in a module worker (`worker.ts`, `ort.ts`); the model files are
  homr's ONNX exports, the segmentation with its weights stored as float16 and the encoder with 8-bit
  weights (see `public/models/homr/README.md`).
- Not included: title recognition (RapidOCR), debug output, the staff-position files, GPU options.
- Added: straightening a photo to four page corners given by the user (`page.ts`) before homr's steps,
  progress / cancel / memory handling (`index.ts`), the page-by-page worker protocol (`protocol.ts`).

Known differences from Python homr (measured, see `public/models/homr/README.md`):

- OpenCV's `minAreaRect` / `boxPoints` float32 rounding is not reproduced bit for bit: on a few long,
  thin staff-line fragments the box can differ by up to 0.1 px (unit tests allow 2 % of boxes).
- The dewarping mesh is triangulated with Bowyer-Watson instead of OpenCV's `Subdiv2D` (both Delaunay;
  only co-circular points can be split differently).
- numpy's unstable `argsort` tie order in homr's peak finder is replaced by a stable order.
- Where Python homr would stop with an exception (a staff without sample points, an empty voice) the
  port skips that staff instead.

Source of the original: https://github.com/liebharc/homr (PyPI package `homr` 0.7.1).
