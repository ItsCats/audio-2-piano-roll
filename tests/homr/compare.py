"""
Agreement of the TypeScript homr port with Python homr: for every page, the notes of the port's
MusicXML scored against the notes of Python homr's MusicXML (score.py of the OMR spike, Python output
as the reference), and whether the two MusicXML files are identical apart from homr's image-position
comments and the XML declaration.

usage: python compare.py TS_OUT PY_OUT   (with the OMR spike's venv: music21, mido; SPIKE env var)
"""

from __future__ import annotations

import glob
import os
import re
import sys

sys.path.insert(0, os.path.join(os.environ["SPIKE"], "scripts"))
import score as sc  # noqa: E402


def norm(xml: str) -> str:
    xml = re.sub(r"<!-- imgpos: [^>]*-->", "", xml)
    xml = re.sub(r"^<\?xml[^>]*\?>\s*", "", xml)
    return xml.strip()


def main() -> None:
    ts_out, py_out = sys.argv[1:3]
    for cat in ("clean", "clean_real", "photo", "photo_real"):
        rows = []
        for py in sorted(glob.glob(os.path.join(py_out, cat, "*.musicxml"))):
            name = os.path.basename(py)
            ts = os.path.join(ts_out, cat, name)
            if not os.path.exists(ts):
                rows.append((name, 0.0, False))
                continue
            same = norm(open(ts).read()) == norm(open(py).read())
            r = sc.score(sc.load_pred(py), sc.load_pred(ts))
            rows.append((name, r["pitchF1"], same))
        if not rows:
            continue
        mean = sum(r[1] for r in rows) / len(rows)
        print(f"{cat:11s} pages {len(rows):2d}  agreement notes F1 {mean:.3f}  identical MusicXML {sum(r[2] for r in rows)}/{len(rows)}")
        for name, f1, same in rows:
            if not same:
                print(f"   {name}: notes F1 vs Python {f1:.3f}")


if __name__ == "__main__":
    main()
