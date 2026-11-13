"""
Decodes page images with OpenCV (as homr does) to raw RGB files for the TypeScript port's harnesses
(tests/homr/parity.run.ts, tests/e2e/homr-bench.mjs): OUT/<category>/<name>.rgb + <name>.json {w, h}.

usage: python to_raw.py TESTSET_DIR OUT_DIR   (TESTSET_DIR/<category>/*.png|*.jpg)
"""

import glob
import json
import os
import sys

import cv2

src, out = sys.argv[1:3]
for f in sorted(glob.glob(os.path.join(src, "*", "*.png")) + glob.glob(os.path.join(src, "*", "*.jpg"))):
    cat = os.path.basename(os.path.dirname(f))
    name = os.path.splitext(os.path.basename(f))[0]
    im = cv2.imread(f)
    os.makedirs(os.path.join(out, cat), exist_ok=True)
    cv2.cvtColor(im, cv2.COLOR_BGR2RGB).tofile(os.path.join(out, cat, name + ".rgb"))
    with open(os.path.join(out, cat, name + ".json"), "w") as fh:
        json.dump({"w": int(im.shape[1]), "h": int(im.shape[0])}, fh)
