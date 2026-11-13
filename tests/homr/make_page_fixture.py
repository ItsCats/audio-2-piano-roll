"""
Page fixtures for tests/unit/homr/pipeline.test.ts: Python homr's intermediate results on one page
(a dump directory written by homr_run.py --dump): the segmentation's class map, the symbol boxes, the
staffs, their notes, the systems, the symbols per voice and the MusicXML. Only use generated pages
(the OMR spike's made-up pieces and their synthetic photos), never third-party scans.

usage: python make_page_fixture.py DUMP_DIR XML_FILE OUT.json
"""

from __future__ import annotations

import base64
import json
import re
import sys
import zlib

import cv2


def main() -> None:
    dump_dir, xml_file, out = sys.argv[1:4]
    d = json.load(open(f"{dump_dir}/dump.json"))
    classes = cv2.imread(f"{dump_dir}/classes.png", cv2.IMREAD_UNCHANGED)
    h, w = classes.shape

    def staff(s):
        grid = s["grid"]
        return {
            "points": len(grid),
            "minX": grid[0][0],
            "maxX": grid[-1][0],
            "minY": min(min(p[1]) for p in grid),
            "maxY": max(max(p[1]) for p in grid),
            # every 10th point: x, the five (or ten) line positions
            "sample": [[p[0], p[1]] for p in grid[::10]],
            "grand": s["is_grandstaff"],
            "notes": s["notes"],
        }

    xml = re.sub(r"<!-- imgpos: [^>]*-->", "", open(xml_file).read())
    fixture = {
        "w": w,
        "h": h,
        "classes": base64.b64encode(zlib.compress(classes.tobytes(), 9)).decode(),
        "boxes": d["boxes"],
        "unit": d["unit"],
        "bar_line_boxes": d["bar_line_boxes"],
        "staffs": [staff(s) for s in d["staffs_with_notes"]],
        "systems": [[staff(s) for s in row] for row in d["repaired"]],
        "voices": d["voices"],
        "xml": xml,
    }
    with open(out, "w") as fh:
        json.dump(fixture, fh, separators=(",", ":"))


if __name__ == "__main__":
    main()
