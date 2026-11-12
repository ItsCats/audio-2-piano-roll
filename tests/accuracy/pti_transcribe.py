"""
Reference-grade piano transcription with the ByteDance high-resolution piano transcription model
(Kong et al. 2021, `piano_transcription_inference`, MIT; checkpoint
CRNN_note_F1=0.9677_pedal_F1=0.9186.pth from zenodo.org/record/4034264, ~165 MB).

The original PyTorch version of the app's optional "High-accuracy piano model" (which runs an ONNX
conversion of the same note model in the browser, src/lib/pianoSpecialist). Here it is an evaluation aid
for solo-piano recordings: it snaps score-aligned notes to the recording's real onsets, is a strong-model
proxy for Basic Pitch, and is the parity reference for the browser port (specialist_eval.py) — which
makes it circular as an accuracy reference for the specialist itself.

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
    # We only need notes: skip the pedal sub-model (3 of the 7 CRNNs, ~40 % of CPU time).
    note_model = tr.model.note_model

    def notes_only(x):
        out = note_model(x)
        z = torch.zeros_like(out["frame_output"][..., :1])
        out.update({"reg_pedal_onset_output": z, "reg_pedal_offset_output": z, "pedal_frame_output": z})
        return out

    tr.model.forward = notes_only
    for f in files:
        name = os.path.splitext(os.path.basename(f))[0]
        out = os.path.join(out_dir, f"{name}.pti.json")
        if os.path.exists(out):
            print("skip", name)
            continue
        # Mono = the mean of the channels, like the package's own load_audio (librosa.load(mono=True)) and the
        # app (decode.ts mixToMono). Not ffmpeg's "-ac 1", which mixes stereo as 0.707·(L+R): 3 dB louder, which
        # moved near-threshold notes (browser parity 0.94–0.98 on loud MP3s instead of 0.99).
        y = load_audio(f, sample_rate, mono=False).mean(axis=0).astype(np.float32)
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
