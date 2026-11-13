"""
Fixtures for tests/unit/homr/*.test.ts: what cv2 (the OpenCV homr runs on) returns for generated
inputs, so the TypeScript ports in src/lib/omr/homr can be compared with it. All inputs are made
here from a fixed random seed (no third-party images).

usage: python make_fixtures.py OUT_DIR   (with the venv that has opencv-python and Pillow)
"""

from __future__ import annotations

import base64
import json
import os
import sys
import zlib

import cv2
import numpy as np
from PIL import Image


def b64(a: np.ndarray) -> str:
    return base64.b64encode(zlib.compress(np.ascontiguousarray(a).tobytes(), 9)).decode()


def rr(r):
    return [[float(r[0][0]), float(r[0][1])], [float(r[1][0]), float(r[1][1])], float(r[2])]


def blobs(rng: np.random.Generator, w: int, h: int) -> np.ndarray:
    m = np.zeros((h, w), np.uint8)
    for _ in range(rng.integers(3, 9)):
        kind = rng.integers(0, 4)
        cx, cy = int(rng.integers(0, w)), int(rng.integers(0, h))
        if kind == 0:
            cv2.ellipse(m, (cx, cy), (int(rng.integers(2, 12)), int(rng.integers(2, 9))), float(rng.integers(0, 180)), 0, 360, 1, -1)
        elif kind == 1:
            cv2.rectangle(m, (cx, cy), (cx + int(rng.integers(1, 20)), cy + int(rng.integers(1, 6))), 1, -1)
        elif kind == 2:
            cv2.line(m, (cx, cy), (cx + int(rng.integers(-25, 25)), cy + int(rng.integers(-25, 25))), 1, int(rng.integers(1, 4)))
        else:
            cv2.circle(m, (cx, cy), int(rng.integers(3, 10)), 1, int(rng.integers(1, 3)))
    # speckles
    for _ in range(rng.integers(0, 12)):
        m[int(rng.integers(0, h)), int(rng.integers(0, w))] = 1
    return m


def main() -> None:
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    rng = np.random.default_rng(1234)

    # ---- contours, hulls, rects, ellipses
    cases = []
    for k in range(40):
        w, h = int(rng.integers(20, 90)), int(rng.integers(15, 70))
        m = blobs(rng, w, h)
        tree, _ = cv2.findContours(m, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
        ext, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        items = []
        for c in tree:
            item = {
                "hull": cv2.convexHull(c).reshape(-1).tolist(),
                "rect": rr(cv2.minAreaRect(c)),
                "area": float(cv2.contourArea(c)),
                "brect": list(cv2.boundingRect(c)),
            }
            if len(c) >= 5:
                item["ellipse"] = rr(cv2.fitEllipse(c))
            items.append(item)
        cases.append(
            {
                "w": w,
                "h": h,
                "mask": b64(m),
                "tree": [c.reshape(-1).tolist() for c in tree],
                "external": [c.reshape(-1).tolist() for c in ext],
                "items": items,
            }
        )

    # ---- rotated rect helpers
    rects = []
    for k in range(300):
        r1 = ((float(rng.uniform(0, 60)), float(rng.uniform(0, 60))), (float(rng.uniform(0.5, 40)), float(rng.uniform(0.5, 12))), float(rng.uniform(-90, 90)))
        r2 = ((float(rng.uniform(0, 60)), float(rng.uniform(0, 60))), (float(rng.uniform(0.5, 40)), float(rng.uniform(0.5, 40))), float(rng.choice([0.0, float(rng.uniform(-90, 90))])))
        p1 = cv2.boxPoints(r1)
        p2 = cv2.boxPoints(r2)
        inter = cv2.rotatedRectangleIntersection(r1, r2)[0] != cv2.INTERSECT_NONE
        area = cv2.intersectConvexConvex(p1.astype(np.float32), p2.astype(np.float32))[0]
        poly = p1.astype(np.int64).astype(np.int32)
        pt = (int(rng.integers(0, 60)), int(rng.integers(0, 60)))
        test = cv2.pointPolygonTest(poly, (float(pt[0]), float(pt[1])), False)
        ell = cv2.ellipse2Poly((int(r1[0][0]), int(r1[0][1])), (int(r1[1][0] / 2), int(r1[1][1] / 2)), int(r1[2]), 0, 360, 1)
        rects.append(
            {
                "r1": rr(r1),
                "r2": rr(r2),
                "p1": p1.astype(np.float64).reshape(-1).tolist(),
                "intersect": bool(inter),
                "area": float(area),
                "pt": pt,
                "test": float(test),
                "ellipse": ell.reshape(-1).tolist(),
            }
        )

    # ---- image ops
    img_rng = np.random.default_rng(99)
    gray = (img_rng.random((70, 97)) * 255).astype(np.uint8)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    gray[20:30, 10:80] = 30
    color = (img_rng.random((41, 53, 3)) * 255).astype(np.uint8)
    mask = blobs(np.random.default_rng(7), 80, 60)
    ops = {
        "gray": {"w": 97, "h": 70, "d": b64(gray)},
        "color": {"w": 53, "h": 41, "d": b64(color)},
        "mask": {"w": 80, "h": 60, "d": b64(mask)},
        "clahe": b64(cv2.createCLAHE(clipLimit=1.0, tileGridSize=(8, 8)).apply(gray)),
        "bgr2gray": b64(cv2.cvtColor(color, cv2.COLOR_BGR2GRAY)),
        "pil_up": {"w": 71, "h": 55, "d": b64(np.array(Image.fromarray(color).resize((71, 55))))},
        "pil_down": {"w": 40, "h": 31, "d": b64(np.array(Image.fromarray(color).resize((40, 31))))},
        "lin_down": {"w": 61, "h": 44, "d": b64(cv2.resize(gray, (61, 44)))},
        "lin_up": {"w": 123, "h": 90, "d": b64(cv2.resize(gray, (123, 90)))},
        "blur7": b64(cv2.blur(color, (7, 7))),
        "noise": [float(np.sum(np.absolute(cv2.filter2D(gray[y : y + 20, x : x + 30], cv2.CV_64F, np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]]))))) for y in (0, 25, 50) for x in (0, 40)],
        "kernels": {
            f"{w}x{h}": cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (w, h)).reshape(-1).tolist()
            for w, h in [(1, 2), (5, 3), (9, 3), (1, 5), (5, 35), (3, 3), (7, 5)]
        },
        "dilate_1x2": b64(cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (1, 2)))),
        "dilate_5x35": b64(cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 35)))),
        "erode_1x5": b64(cv2.erode(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (1, 5)))),
        "dilate_rect53": b64(cv2.dilate(mask, np.ones((5, 3), np.uint8), iterations=1)),
        "close7": b64(cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))),
        "erode9": b64(cv2.morphologyEx(mask, cv2.MORPH_ERODE, np.ones((9, 9), np.uint8))),
        "warp": {
            "m": [[0.98, 0.05, 1.7], [-0.03, 1.02, -2.2]],
            "w": 90,
            "h": 66,
            "d": b64(cv2.warpAffine(gray, np.array([[0.98, 0.05, 1.7], [-0.03, 1.02, -2.2]]), (90, 66), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=1)),
        },
        "fillconvex": b64(cv2.fillConvexPoly(np.zeros((40, 50), np.uint8), np.array([[3, 2], [45, 9], [20, 37]], np.int32), 255)),
    }
    with open(os.path.join(out, "cv.json"), "w") as fh:
        json.dump({"cases": cases, "rects": rects, "ops": ops}, fh, separators=(",", ":"))
    print("wrote", os.path.join(out, "cv.json"), os.path.getsize(os.path.join(out, "cv.json")))
    subdiv_fixtures(out)


def subdiv_fixtures(out: str) -> None:
    """cv2.Subdiv2D triangle lists (in order) for homr-like dewarping meshes and random point sets."""
    rng = np.random.default_rng(2024)
    sets = []
    for k in range(24):
        if k < 12:
            # a dewarping mesh like homr's: image corners, rows of points every 80 px with a staff's
            # small vertical offsets, each row closed by points on the left and right edges
            w, h = int(rng.integers(600, 1400)), int(rng.integers(200, 400))
            pts = [(0, 0), (w, 0)]
            step = h // 6
            bend = rng.integers(-3, 4, size=w // 80 + 2) if k % 3 else np.zeros(w // 80 + 2, int)
            for y in range(2, h - 2, step):
                row = [(x, y + int(bend[i])) for i, x in enumerate(range(2, w, 80)) if 10 <= x <= w - 10 and 10 <= y + int(bend[i]) <= h - 10]
                if len(row) > 2:
                    pts += [(0, row[0][1])] + row + [(w, row[-1][1])]
            pts += [(0, h), (w, h)]
            if k % 2:
                avg = [(x, int(round(y))) for x, y in pts]
                pts = avg
        elif k < 18:
            n = int(rng.integers(5, 60))
            pts = [(float(x), float(y)) for x, y in rng.random((n, 2)) * [500, 300]]
            if k % 2:
                pts += pts[:3]  # duplicates
        else:
            # integer grid with collinear and co-circular points, plus points on grid edges
            g = int(rng.integers(3, 8))
            pts = [(x * 40, y * 30) for y in range(g) for x in range(g)]
            pts += [(x * 40 + 20, 0) for x in range(g - 1)]
        p = np.array(pts, np.float32)
        rect = cv2.boundingRect(p.reshape(-1, 1, 2))
        rect = (rect[0] - 10, rect[1] - 10, rect[2] + 20, rect[3] + 20)
        sub = cv2.Subdiv2D(rect)
        for q in p:
            sub.insert((float(q[0]), float(q[1])))
        sets.append({"points": p.astype(np.float64).tolist(), "rect": list(rect), "triangles": sub.getTriangleList().astype(np.float64).tolist()})
    with open(os.path.join(out, "subdiv.json"), "w") as fh:
        json.dump(sets, fh, separators=(",", ":"))
    print("wrote", os.path.join(out, "subdiv.json"), os.path.getsize(os.path.join(out, "subdiv.json")))


if __name__ == "__main__":
    main()
