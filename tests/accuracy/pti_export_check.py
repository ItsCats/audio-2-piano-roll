"""
Parity of the browser piano-specialist ONNX file (pti_export.py) against the PyTorch model it came from.

    server/.venv/bin/python tests/accuracy/pti_export_check.py CHECKPOINT MODEL.onnx OUT_DIR \
        AUDIO[@START[+SECONDS]] [...] [--threads 3] [--onnx-only]

Each AUDIO is decoded to 16 kHz mono with ffmpeg (acclib.load_audio), optionally cut to START..START+SECONDS,
and run through BOTH the PyTorch note model (float32, piano_transcription_inference 0.0.6) and the ONNX file
(onnxruntime CPU) with the package's own segmentation: zero-pad to a multiple of 160000 samples, 10 s
segments with 50 % overlap, PianoTranscription.deframe (drop each segment's last frame, keep the middle
halves). Prints per output the max abs difference, the agreement of the post-processor thresholds
(frame > 0.1, onset > 0.3, offset > 0.3) and the note-level agreement of RegressionPostProcessor
(notes matched by pitch with onsets within 10 ms; the largest onset / offset / velocity differences).

Writes OUT_DIR/<id>.audio16k.f32 (the exact 16 kHz input, raw little-endian float32) and
OUT_DIR/<id>.torch.{frame,onset,offset,velocity}.f32 ([nFrames, 88] float32) plus <id>.json, so the
browser worker can be checked on the same input (tests/e2e/pianoSpecialist.mjs style harness).
and OUT_DIR/<id>.onnx.* (the ONNX outputs). With --onnx-only the PyTorch side is skipped.
Scratch output only: never write it into the repository (recordings are copyrighted).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import load_audio  # noqa: E402

SEG = 160000
KEYS = ["frame", "onset", "offset", "velocity"]
TORCH_KEYS = {"frame": "frame_output", "onset": "reg_onset_output", "offset": "reg_offset_output", "velocity": "velocity_output"}
THRESH = {"frame": 0.1, "onset": 0.3, "offset": 0.3}


def segments(y: np.ndarray) -> tuple[np.ndarray, int]:
    from piano_transcription_inference import PianoTranscription

    n = len(y)
    pad = int(np.ceil(n / SEG)) * SEG - n
    x = np.concatenate([y, np.zeros(pad, np.float32)])[None, :]
    return PianoTranscription.enframe(None, x, SEG).astype(np.float32), n


def deframe(stack: np.ndarray) -> np.ndarray:
    from piano_transcription_inference import PianoTranscription

    return PianoTranscription.deframe(None, stack)


def run_torch(model, segs):
    import torch

    outs = {k: [] for k in KEYS}
    with torch.no_grad():
        for s in segs:
            o = model(torch.from_numpy(s[None, :]))
            for k in KEYS:
                outs[k].append(o[TORCH_KEYS[k]].numpy())
    return {k: deframe(np.concatenate(v, 0)) for k, v in outs.items()}


def run_onnx(sess, segs):
    outs = {k: [] for k in KEYS}
    for s in segs:
        o = sess.run(KEYS, {"audio": s[None, :]})
        for k, v in zip(KEYS, o):
            outs[k].append(v)
    return {k: deframe(np.concatenate(v, 0)) for k, v in outs.items()}


def notes_of(d):
    from piano_transcription_inference.utilities import RegressionPostProcessor

    pp = RegressionPostProcessor(100, classes_num=88, onset_threshold=0.3, offset_threshold=0.3, frame_threshold=0.1, pedal_offset_threshold=0.2)
    z = np.zeros_like(d["frame"][:, :1])
    od = {"reg_onset_output": d["onset"], "reg_offset_output": d["offset"], "frame_output": d["frame"], "velocity_output": d["velocity"],
          "reg_pedal_onset_output": z, "reg_pedal_offset_output": z, "pedal_frame_output": z}
    ev, _ = pp.output_dict_to_midi_events(od)
    return sorted((e["midi_note"], round(e["onset_time"], 4), round(e["offset_time"], 4), e["velocity"]) for e in ev)


def note_agreement(a, b) -> dict:
    """Greedy match by pitch with onsets within 10 ms; reports the largest timing / velocity differences."""
    used = [False] * len(b)
    pairs = []
    for p, on, off, v in a:
        best = None
        for j, (p2, on2, off2, v2) in enumerate(b):
            if not used[j] and p2 == p and abs(on2 - on) <= 0.01 and (best is None or abs(on2 - on) < abs(b[best][1] - on)):
                best = j
        if best is not None:
            used[best] = True
            pairs.append((on - b[best][1], off - b[best][2], v - b[best][3]))
    d = np.abs(np.array(pairs)) if pairs else np.zeros((1, 3))
    return {
        "notes_a": len(a), "notes_b": len(b), "matched": len(pairs),
        "max_onset_diff_ms": round(float(d[:, 0].max()) * 1000, 2), "max_offset_diff_ms": round(float(d[:, 1].max()) * 1000, 2),
        "max_velocity_diff": int(d[:, 2].max()), "velocity_diffs": int((d[:, 2] > 0).sum()),
    }


def compare(a, b) -> dict:
    r = {}
    for k in KEYS:
        d = np.abs(a[k] - b[k])
        r[k] = {"max_abs_diff": float(d.max()), "mean_abs_diff": float(d.mean())}
        if k in THRESH:
            r[k]["thresholded_agreement"] = float(((a[k] > THRESH[k]) == (b[k] > THRESH[k])).mean())
    va, vb = np.round(a["velocity"] * 128), np.round(b["velocity"] * 128)
    r["velocity"]["max_diff_128"] = float(np.abs(va - vb).max())
    r["notes"] = note_agreement(notes_of(a), notes_of(b))
    return r


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint")
    ap.add_argument("onnx")
    ap.add_argument("out_dir")
    ap.add_argument("audio", nargs="+")
    ap.add_argument("--threads", type=int, default=3)
    ap.add_argument("--onnx-only", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out_dir, exist_ok=True)

    import onnxruntime as ort
    import torch

    torch.set_num_threads(a.threads)
    so = ort.SessionOptions()
    so.intra_op_num_threads = a.threads
    sess = ort.InferenceSession(a.onnx, so, providers=["CPUExecutionProvider"])
    model = None
    if not a.onnx_only:
        from piano_transcription_inference.models import Regress_onset_offset_frame_velocity_CRNN

        model = Regress_onset_offset_frame_velocity_CRNN(frames_per_second=100, classes_num=88)
        model.load_state_dict(torch.load(a.checkpoint, map_location="cpu", weights_only=False)["model"]["note_model"])
        model.eval()

    report = {}
    for spec in a.audio:
        path, start, dur = spec, 0.0, None
        if "@" in spec:
            path, cut = spec.rsplit("@", 1)
            start, _, d = cut.partition("+")
            start, dur = float(start), (float(d) if d else None)
        y = load_audio(path, 16000)
        y = y[int(start * 16000): (int((start + dur) * 16000) if dur else None)].astype(np.float32)
        rid = os.path.splitext(os.path.basename(path))[0] + (f"@{start:g}+{dur:g}" if dur else (f"@{start:g}" if start else ""))
        y.tofile(os.path.join(a.out_dir, f"{rid}.audio16k.f32"))
        segs, n = segments(y)
        t0 = time.time()
        o = run_onnx(sess, segs)
        t_onnx = time.time() - t0
        info = {"id": rid, "samples": n, "seconds": n / 16000, "segments": len(segs), "nFrames": int(o["frame"].shape[0]), "onnx_s": round(t_onnx, 2)}
        if model is not None:
            t0 = time.time()
            t = run_torch(model, segs)
            info["torch_s"] = round(time.time() - t0, 2)
            for k in KEYS:
                t[k].astype(np.float32).tofile(os.path.join(a.out_dir, f"{rid}.torch.{k}.f32"))
            info["onnx_vs_torch"] = compare(t, o)
        for k in KEYS:
            o[k].astype(np.float32).tofile(os.path.join(a.out_dir, f"{rid}.onnx.{k}.f32"))
        json.dump(info, open(os.path.join(a.out_dir, f"{rid}.json"), "w"), indent=1)
        report[rid] = info
        print(json.dumps(info), flush=True)


if __name__ == "__main__":
    main()
