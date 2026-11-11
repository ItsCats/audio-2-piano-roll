"""
Reference-grade piano transcription with the ByteDance high-resolution piano transcription model
(Kong et al. 2021, `piano_transcription_inference`, Apache-2.0; checkpoint
CRNN_note_F1=0.9677_pedal_F1=0.9186.pth from zenodo.org/record/4034264, ~165 MB).

Used ONLY as an evaluation aid for solo-piano recordings (to snap score-aligned notes to the
recording's real onsets, and as a strong-model proxy), never by the app.

    server/.venv/bin/python tests/accuracy/pti_transcribe.py CHECKPOINT OUT_DIR audio1 [audio2 ...]
Writes OUT_DIR/<name>.pti.json (acclib notes format, pedal-extended offsets kept as the model gives).
"""
import os
import sys
import time

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import NoteArr, load_audio, save_notes  # noqa: E402
import numpy as np  # noqa: E402


def main() -> None:
    ckpt, out_dir, files = sys.argv[1], sys.argv[2], sys.argv[3:]
    os.makedirs(out_dir, exist_ok=True)
    torch.set_num_threads(int(os.environ.get("PTI_THREADS", os.cpu_count() or 4)))
    from piano_transcription_inference import PianoTranscription, sample_rate

    tr = PianoTranscription(device="cpu", checkpoint_path=ckpt)
    for f in files:
        name = os.path.splitext(os.path.basename(f))[0]
        out = os.path.join(out_dir, f"{name}.pti.json")
        if os.path.exists(out):
            print("skip", name)
            continue
        y = load_audio(f, sample_rate)
        t0 = time.time()
        res = tr.transcribe(y, os.path.join(out_dir, f"{name}.pti.mid"))
        ev = res["est_note_events"]
        notes = NoteArr(
            np.array([e["onset_time"] for e in ev]), np.array([e["offset_time"] for e in ev]),
            np.array([e["midi_note"] for e in ev], int), np.array([e["velocity"] / 127 for e in ev]),
            np.array(["?"] * len(ev)),
        ).sorted()
        save_notes(out, notes, {"model": "bytedance-piano-transcription CRNN note F1=0.9677", "seconds": round(time.time() - t0, 1)})
        print(f"{name}: {len(notes)} notes in {time.time() - t0:.0f}s for {len(y) / sample_rate:.0f}s audio", flush=True)


if __name__ == "__main__":
    main()
