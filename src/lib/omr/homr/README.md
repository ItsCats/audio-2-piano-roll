# homr sheet-music reader (TypeScript port)

This directory is derived from **homr** (https://github.com/liebharc/homr), an optical music
recognition program by Christian Liebhardt and the homr contributors, licensed under the
**GNU Affero General Public License v3.0** (AGPL-3.0; licence text: `public/models/homr/LICENSE`).
It is a port of homr 0.7.1's inference pipeline from Python to TypeScript, so it is a modified version
of homr and is itself licensed under the AGPL-3.0. Copyright of the original work: the homr
contributors. Changes: Copyright the Piano2Vision contributors, 2026, also AGPL-3.0.

## Licences of the files here

homr is licensed under the AGPL **version 3 only** (its `pyproject.toml` says `AGPL-3.0`; neither its
README nor its LICENSE offers "any later version"). So:

| Files | Licence (SPDX, as in each file's first line) |
|---|---|
| ports of homr modules: `boxes.ts`, `model.ts`, `ort.ts`, `pipeline.ts`, `preprocess.ts`, `staffDetection.ts`, `staffImage.ts`, `symbols.ts`, `systemRepair.ts`, `triplets.ts`, `vocabulary.ts` | `AGPL-3.0-only` |
| `musicxml.ts` (homr's writer, and its page joining based on relieur) | `AGPL-3.0-only AND Apache-2.0` |
| `geom.ts`, `subdiv2d.ts` (OpenCV functions homr calls) | `AGPL-3.0-only AND BSD-3-Clause` |
| `cv.ts` (OpenCV and Pillow image operations homr calls) | `AGPL-3.0-only AND BSD-3-Clause AND Apache-2.0 AND MIT-CMU` |
| new code written for Piano2Vision: `index.ts`, `worker.ts`, `protocol.ts`, `page.ts`, `xml.ts`, `fp16w.ts`, `manifest.ts` | `AGPL-3.0-or-later` |
| the model files in `public/models/homr/` | AGPL-3.0 (homr's weights; see the README there) |

Every ported file says in its first lines that it was modified (a TypeScript port of homr 0.7.1) by the
Piano2Vision contributors in 2026, and which homr module it follows.

## Third-party notices

| Component | Used for | Copyright | Licence |
|---|---|---|---|
| homr 0.7.1 (https://github.com/liebharc/homr) | the whole pipeline (ported) and the three networks | Christian Liebhardt and the homr contributors | AGPL-3.0 (`public/models/homr/LICENSE`, unchanged); homr has no NOTICE file |
| relieur (https://github.com/papoteur-mga/relieur) | joining pages (via homr's `relieur.py`, ported in `musicxml.ts`) | Papoteur and contributors | Apache-2.0 (no NOTICE file upstream) |
| OpenCV 4.x imgproc (https://github.com/opencv/opencv) | contours, hulls, rotated boxes, ellipses, Subdiv2D, polygon fill, CLAHE, resize, morphology, blur, warpAffine (ported in `geom.ts`, `subdiv2d.ts`, `cv.ts`) | Intel Corporation, Willow Garage, NVIDIA, Itseez, Advanced Micro Devices and others | 3-clause BSD and Apache-2.0: `LICENSE-OpenCV.txt` here |
| Pillow (https://github.com/python-pillow/Pillow) | bicubic resize (ported in `cv.ts`) | Secret Labs AB, Fredrik Lundh, Jeffrey A. Clark and contributors | MIT-CMU: `LICENSE-Pillow.txt` here |
| onnxruntime-web 1.31.1 | runs the networks (npm dependency) | Microsoft Corporation | MIT |

When the app is built, these notices must also reach the repository-wide `THIRD_PARTY_NOTICES.md` and
the Credits page (`src/lib/credits.ts` has the homr, training-data, OpenCV and Pillow entries).

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
- `cv.ts` ports OpenCV's `fillPoly` / `fillConvexPoly` (outline lines and span filling, pixel for pixel)
  for the paper mask of the autocrop and the dewarping triangles.
- `subdiv2d.ts` ports OpenCV's `Subdiv2D` (3-clause BSD, `LICENSE-OpenCV.txt`) so the dewarping mesh has the same triangles in the
  same order as in homr (pixels on shared triangle edges take the later triangle's value).
- Added: straightening a photo to four page corners given by the user (`page.ts`) before homr's steps,
  progress / cancel / memory handling (`index.ts`), the page-by-page worker protocol (`protocol.ts`),
  a low-memory mode for phones (one network at a time, `ort.ts` `stagedInfer`), float16 weights expanded
  to float32 before session creation (`fp16w.ts`, lower peak memory, same numbers), a size limit on
  input images (scaled down to 4000 px; images over three times taller than wide are not read), and a
  second try on landscape pages without music, turned by 90 degrees (sideways scans; `readPageUpright`
  in `pipeline.ts`). An upside-down page still yields wrong notes rather than none, so the turn is
  chosen by where the clef and key-signature boxes sit on the staffs (at the start when upright: 17 of
  17 on a test page, at the end upside down: 13 of 13); a test page turned clockwise came back with
  MusicXML identical to the upright page's.

Known differences from Python homr (measured, see `public/models/homr/README.md`):

- OpenCV's `minAreaRect` / `boxPoints` float32 rounding is not reproduced bit for bit: on a few long,
  thin staff-line fragments the box can differ by up to 0.1 px (unit tests allow 2 % of boxes).
- The transformer encoder's int8 matrix products in onnxruntime-web (WASM) round slightly differently
  from onnxruntime's native CPU kernels: on identical staff images, a decoded symbol can differ. On the
  test set that happened only to symbols that are not notes (an accent, a staccato), but on harder input
  it can also change a rhythm (e.g. a low-resolution photo: eighths instead of a triplet group on one
  staff). Neither side is closer to the float32 encoder. Shipping the encoder with float16 weights instead
  (+9 MB) would give the same output as Python homr.
- numpy's unstable `argsort` tie order in homr's peak finder is replaced by a stable order.
- Where Python homr would stop with an exception (a staff without sample points, an empty voice) the
  port skips that staff instead.

Source of the original: https://github.com/liebharc/homr (PyPI package `homr` 0.7.1).

## Before the reader goes live (licence checklist for the merge)

The files here carry their own notices; these repository-level items are done on the integration
branch, not here, and must ship together with the reader:

1. The GitHub repository is public before any production deploy that contains `src/lib/omr/homr/` or
   `public/models/homr/`, and production is deployed only from pushed commits (the source offered must
   be the source served; ideally the source link points at the deployed commit, e.g. Netlify's
   `COMMIT_REF` as `VITE_COMMIT` → `/tree/<sha>`).
2. A top-level `LICENSE` with the AGPL-3.0 text and a `license` field in `package.json`. homr is
   AGPL-3.0 **only**, so if the rest of the app is "or later", say so for both parts (e.g.
   `"AGPL-3.0-or-later AND AGPL-3.0-only"`, and in the README, Terms and Credits: "version 3 or later;
   the homr sheet-music reader is version 3 only").
3. A visible source-code link in the app (AGPL section 13), and a copyright line (e.g. in the Credits
   footer or Terms) next to the existing warranty disclaimer and licence name.
4. `THIRD_PARTY_NOTICES.md`: rows for this directory (homr port, AGPL-3.0-only), `public/models/homr/`
   (homr's weights, AGPL-3.0, converted by `tests/homr/convert_models.py` and `package_models.py`,
   training data incl. Camera-PrIMuS CC BY-NC 4.0), relieur (Apache-2.0), OpenCV (BSD-3-Clause /
   Apache-2.0, `LICENSE-OpenCV.txt`) and Pillow (MIT-CMU, `LICENSE-Pillow.txt`), as in the table above;
   homr in the README's credits list. Keep the integration branch's `src/lib/credits.ts` header (its
   source-link block) and add this branch's homr, training-data, OpenCV and Pillow entries.
5. Optional: a short "Reader: homr (AGPL-3.0) · source" line next to the reader choice on the Import page.
6. The app stays free and non-commercial (Camera-PrIMuS); adding ads, donations or paid features would
   need this reviewed again.
