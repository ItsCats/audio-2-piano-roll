"""
Ships homr's ONNX models for the browser: splits each file into pieces under 10 MB (Netlify's
recommended largest file) as public/models/homr/<name>.partN.bin and writes their sizes and sha256
(of the joined file) to src/lib/omr/homr/manifest.ts, which the worker checks after joining.

usage: python package_models.py REPO_DIR SEGNET.onnx ENCODER.onnx DECODER.onnx
"""

from __future__ import annotations

import hashlib
import json
import os
import sys

PIECE = 9_500_000


def main() -> None:
    repo = sys.argv[1]
    files = {"segnet": sys.argv[2], "encoder": sys.argv[3], "decoder": sys.argv[4]}
    out_dir = os.path.join(repo, "public", "models", "homr")
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        if f.endswith(".bin"):
            os.remove(os.path.join(out_dir, f))
    manifest = {}
    for name, path in files.items():
        data = open(path, "rb").read()
        variant = os.path.basename(path).split(".")[1] if path.count(".") >= 2 else "fp32"
        file = f"{name}.{variant}.onnx"
        parts = []
        for i in range(0, len(data), PIECE):
            part = f"{name}.{variant}.part{len(parts) + 1}.bin"
            with open(os.path.join(out_dir, part), "wb") as fh:
                fh.write(data[i : i + PIECE])
            parts.append(f"models/homr/{part}")
        manifest[name] = {"file": file, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "parts": parts}
        print(name, file, len(data), len(parts), "pieces")
    ts = os.path.join(repo, "src", "lib", "omr", "homr", "manifest.ts")
    with open(ts, "w") as fh:
        fh.write("// Written by tests/homr/package_models.py: the shipped model files (public/models/homr/).\n")
        fh.write("export const HOMR_MODELS = " + json.dumps(manifest, indent=2) + " as const;\n")
    print("wrote", ts)


if __name__ == "__main__":
    main()
