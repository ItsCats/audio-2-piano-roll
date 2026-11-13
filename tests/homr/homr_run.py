"""
Runs Python homr 0.7.1 (the reference for src/lib/omr/homr) on images, without title detection
(homr --no-title), with model files of choice, and optionally dumps the intermediate results which
the TypeScript port is compared against (tests/homr/compare_dump.mjs, src/lib/omr/homr/*.test.ts).

The steps are the ones of homr.main.process_image / detect_staffs_in_image, called one by one.

usage: python homr_run.py --out DIR [--segnet F] [--encoder F] [--decoder F] [--dump] IMAGE...
       (run with the venv that has homr installed)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import xml.etree.ElementTree as ET

import cv2
import numpy as np


def box_json(b):
    return [[float(b.box[0][0]), float(b.box[0][1])], [float(b.box[1][0]), float(b.box[1][1])], float(b.box[2])]


def staff_json(s):
    return {
        "grid": [[float(p.x), [float(y) for y in p.y], float(p.angle)] for p in s.grid],
        "is_grandstaff": bool(s.is_grandstaff),
        "notes": [[float(n.center[0]), float(n.center[1]), int(n.position)] for n in s.get_notes()],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--segnet")
    ap.add_argument("--encoder")
    ap.add_argument("--decoder")
    ap.add_argument("--dump", action="store_true")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("images", nargs="+")
    a = ap.parse_args()

    import onnxruntime as ort

    if a.threads:
        orig = ort.InferenceSession

        def session(path, *args, **kw):
            so = kw.pop("sess_options", None) or ort.SessionOptions()
            so.intra_op_num_threads = a.threads
            return orig(path, sess_options=so, *args, **kw)

        ort.InferenceSession = session  # type: ignore

    from homr import color_adjust
    from homr.autocrop import autocrop_with_offset
    from homr.bar_line_detection import detect_bar_lines
    from homr.brace_dot_detection import find_braces_brackets_and_grand_staff_lines, prepare_brace_dot_image
    from homr.bounding_boxes import create_rotated_bounding_boxes
    from homr.debug import Debug
    from homr.main import get_predictions, predict_symbols
    from homr.music_xml_generator import XmlGeneratorArguments, generate_xml
    from homr.noise_filtering import filter_predictions
    from homr.note_detection import add_notes_to_staffs, combine_noteheads_with_stems
    from homr.resize import resize_image
    import homr.segmentation.inference_segnet as seg
    from homr.staff_detection import break_wide_fragments, detect_staff, estimate_unit_size_from_clefs, make_lines_stronger
    import homr.staff_parsing as sp
    from homr.system_repair import repair_systems
    from homr.transformer.configs import Config

    if a.segnet:
        seg.segnet_path_onnx = a.segnet
    config = Config()
    config.use_gpu_inference = False
    if a.encoder:
        config.filepaths.encoder_path = a.encoder
    if a.decoder:
        config.filepaths.decoder_path = a.decoder

    os.makedirs(a.out, exist_ok=True)
    for path in a.images:
        name = os.path.splitext(os.path.basename(path))[0]
        dump: dict = {}
        t0 = time.time()
        image = cv2.imread(path)
        image, crop = autocrop_with_offset(image)
        dump["crop"] = [int(crop[0]), int(crop[1]), int(image.shape[1]), int(image.shape[0])]
        image = resize_image(image)
        dump["resized"] = [int(image.shape[1]), int(image.shape[0])]
        pre = color_adjust.apply_clahe(image)
        t_seg = time.time()
        pred = get_predictions(image, pre, path, False, False)
        t_seg = time.time() - t_seg
        if a.dump:
            d = os.path.join(a.out, name + "_dump")
            os.makedirs(d, exist_ok=True)
            cv2.imwrite(os.path.join(d, "resized.png"), image)
            cv2.imwrite(os.path.join(d, "clahe.png"), pre)
            # class map 0..5 as one 8-bit PNG
            cls = pred.stems_rest * 1 + pred.notehead * 2 + pred.clefs_keys * 3 + pred.staff * 4 + pred.symbols * 5
            cv2.imwrite(os.path.join(d, "classes.png"), cls.astype(np.uint8))
        debug = Debug(pred.original, path, False)
        pred = filter_predictions(pred, debug)
        pred.staff = make_lines_stronger(pred.staff, (1, 2))
        sym = predict_symbols(debug, pred)
        dump["boxes"] = {
            "noteheads": [box_json(b) for b in sym.noteheads],
            "staff_fragments": [box_json(b) for b in sym.staff_fragments],
            "clefs_keys": [box_json(b) for b in sym.clefs_keys],
            "stems_rest": [box_json(b) for b in sym.stems_rest],
            "bar_lines": [box_json(b) for b in sym.bar_lines],
        }
        sym.staff_fragments = break_wide_fragments(sym.staff_fragments)
        dump["boxes"]["staff_fragments_broken"] = [box_json(b) for b in sym.staff_fragments]
        nws = combine_noteheads_with_stems(sym.noteheads, sym.stems_rest)
        if len(nws) > 0:
            unit = float(np.median([n.notehead.size[1] for n in nws]))
        else:
            unit = estimate_unit_size_from_clefs(sym.staff_fragments, sym.clefs_keys)
        dump["unit"] = unit
        dump["noteheads_with_stems"] = [
            [box_json(n.notehead), box_json(n.stem) if n.stem is not None else None] for n in nws
        ]
        all_noteheads = [n.notehead for n in nws]
        all_stems = [n.stem for n in nws if n.stem is not None]
        bar_lines_or_rests = [
            line
            for line in sym.bar_lines
            if not line.is_overlapping_with_any(all_noteheads) and not line.is_overlapping_with_any(all_stems)
        ]
        bar_line_boxes = detect_bar_lines(bar_lines_or_rests, unit)
        dump["bar_line_boxes"] = [box_json(b) for b in bar_line_boxes]
        staffs = detect_staff(debug, pred.staff, sym.staff_fragments, sym.clefs_keys, bar_line_boxes, pred.symbols)
        dump["staffs"] = [staff_json(s) for s in staffs]
        brace_dot_img = prepare_brace_dot_image(pred.symbols, pred.staff)
        brace_dot = create_rotated_bounding_boxes(brace_dot_img, skip_merging=True, max_size=(100, -1))
        dump["brace_dot"] = [box_json(b) for b in brace_dot]
        add_notes_to_staffs(staffs, nws, pred.symbols, pred.notehead)
        dump["staffs_with_notes"] = [staff_json(s) for s in staffs]
        multi = find_braces_brackets_and_grand_staff_lines(debug, staffs, brace_dot)
        dump["multi"] = [[staff_json(s) for s in m.staffs] for m in multi]
        multi = repair_systems(debug, multi)
        dump["repaired"] = [[staff_json(s) for s in m.staffs] for m in multi]

        staff_images = []
        orig_parse = sp.parse_staff_tromr

        def capture(staff, staff_image, config):
            res = orig_parse(staff=staff, staff_image=staff_image, config=config)
            staff_images.append(staff_image)
            dump.setdefault("tokens", []).append([str(r) for r in res])
            return res

        sp.parse_staff_tromr = capture
        t_tr = time.time()
        result = sp.parse_staffs(debug, multi, pred.preprocessed, config=config)
        t_tr = time.time() - t_tr
        sp.parse_staff_tromr = orig_parse
        dump["voices"] = [[str(s) for s in v] for v in result]
        xml = generate_xml(XmlGeneratorArguments(None, None, None), result, "")
        out_xml = os.path.join(a.out, name + ".musicxml")
        ET.ElementTree(xml).write(out_xml, encoding="unicode", xml_declaration=True)
        dump["seconds"] = {"total": time.time() - t0, "segnet": t_seg, "transformer": t_tr}
        if a.dump:
            d = os.path.join(a.out, name + "_dump")
            for i, im in enumerate(staff_images):
                cv2.imwrite(os.path.join(d, f"staff{i}.png"), im)
            with open(os.path.join(d, "dump.json"), "w") as fh:
                json.dump(dump, fh)
        print(name, "staffs", len(staffs), "s=%.1f" % (time.time() - t0), file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
