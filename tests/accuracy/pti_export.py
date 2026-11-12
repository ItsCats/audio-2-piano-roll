"""
Export the ByteDance high-resolution piano transcription NOTE model (Kong et al. 2021) to ONNX for the
browser ("Solo piano - high accuracy", src/lib/pianoSpecialist/).

    server/.venv/bin/python tests/accuracy/pti_export.py CHECKPOINT OUT.onnx [--fp32 OUT_FP32.onnx]
        [--from-fp32 FP32.onnx] [--basis graph|fp16|fp32] [--split 5]

The app ships the file split into consecutive pieces (Netlify recommends at most 10 MB per deployed
file); --split N also writes OUT_without_.onnx.part1.bin .. partN.bin next to OUT (the worker fetches and
joins them, then checks the whole file's sha256):

    server/.venv/bin/python tests/accuracy/pti_export.py pti.pth /tmp/x/piano-note.fp16.onnx --split 5
    cp /tmp/x/piano-note.fp16.part*.bin public/models/piano-specialist/

CHECKPOINT is "CRNN_note_F1=0.9677_pedal_F1=0.9186.pth" (zenodo.org/record/4034264, CC BY 4.0); the model
code is piano_transcription_inference 0.0.6 (MIT, github.com/qiuqiangkong/piano_transcription_inference;
declared in setup.py / PyPI, no LICENSE file), which must be importable (server/.venv has it). The training
code, github.com/bytedance/piano_transcription, is Apache-2.0 (its README).

Graph: input "audio" [1, 160000] float32 (10 s of 16 kHz mono, the package's segment_samples) ->
outputs "frame", "onset", "offset", "velocity", each [1, 1001, 88] float32 (100 frames/s, MIDI 21..108;
onset/offset are the regression outputs reg_onset_output / reg_offset_output). The log-mel front end
(torchlibrosa STFT as Conv1d, reflect padding, mel filterbank, power_to_db) is inside the graph. The pedal
model is not exported.

Weights are STORED as float16 and cast to float32 inside the graph (one Cast per initializer, which
onnxruntime constant-folds when the session is created), so the WASM backend runs plain float32 kernels;
the file is half the size of the float32 export. Initializers under 1024 values (biases, batch-norm
statistics) stay float32. int8 dynamic quantisation was tried and broke the GRUs - don't.

--basis (the STFT's windowed DFT basis, 2 x 1025 x 2048 = 4.2 M values, 8.4 MB even in float16):
  graph (default)  computed inside the graph from integers: ((k * n) mod 2048) * 2pi / 2048 -> cos / -sin,
                   times the periodic Hann window, so it costs nothing in the file and stays float32-exact
  fp16 / fp32      stored like the other weights / stored as float32

Prints the file's size and sha256. pti_export_check.py measures the parity against PyTorch.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
import tempfile

import numpy as np

SEGMENT_SAMPLES = 160000
N_FFT = 2048
SMALL = 1024


def export_fp32(checkpoint: str, out: str) -> None:
    import torch
    from piano_transcription_inference.models import Regress_onset_offset_frame_velocity_CRNN

    model = Regress_onset_offset_frame_velocity_CRNN(frames_per_second=100, classes_num=88)
    # the checkpoint holds {"model": {"note_model": state_dict, "pedal_model": state_dict}}
    note = torch.load(checkpoint, map_location="cpu", weights_only=False)["model"]["note_model"]
    model.load_state_dict(note, strict=True)
    model.eval()

    class Wrap(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, x):
            o = self.m(x)
            return o["frame_output"], o["reg_onset_output"], o["reg_offset_output"], o["velocity_output"]

    x = torch.zeros(1, SEGMENT_SAMPLES)
    with torch.no_grad():
        torch.onnx.export(
            Wrap(model).eval(), x, out, input_names=["audio"], output_names=["frame", "onset", "offset", "velocity"],
            opset_version=17, dynamo=False, do_constant_folding=True,
        )


def basis_nodes(real_name: str, imag_name: str):
    """Nodes computing torchlibrosa's conv_real / conv_imag weights [1025, 1, 2048] in float32."""
    from onnx import TensorProto, helper, numpy_helper

    p = "stft_basis_"
    inits = [
        numpy_helper.from_array(np.arange(N_FFT // 2 + 1, dtype=np.int64).reshape(-1, 1), p + "k"),
        numpy_helper.from_array(np.arange(N_FFT, dtype=np.int64).reshape(1, -1), p + "n"),
        numpy_helper.from_array(np.array(N_FFT, dtype=np.int64), p + "N"),
        numpy_helper.from_array(np.array(2 * np.pi / N_FFT, dtype=np.float32), p + "step"),
        numpy_helper.from_array(np.array(0.5, dtype=np.float32), p + "half"),
        numpy_helper.from_array(np.array([N_FFT // 2 + 1, 1, N_FFT], dtype=np.int64), p + "shape"),
    ]
    nodes = [
        helper.make_node("Mul", [p + "k", p + "n"], [p + "kn"]),
        helper.make_node("Mod", [p + "kn", p + "N"], [p + "knmod"], fmod=0),
        helper.make_node("Cast", [p + "knmod"], [p + "knf"], to=TensorProto.FLOAT),
        helper.make_node("Mul", [p + "knf", p + "step"], [p + "arg"]),
        # periodic Hann window: 0.5 - 0.5 cos(2 pi n / N) (librosa get_window('hann', N, fftbins=True))
        helper.make_node("Cast", [p + "n"], [p + "nf"], to=TensorProto.FLOAT),
        helper.make_node("Mul", [p + "nf", p + "step"], [p + "warg"]),
        helper.make_node("Cos", [p + "warg"], [p + "wcos"]),
        helper.make_node("Mul", [p + "wcos", p + "half"], [p + "whalf"]),
        helper.make_node("Sub", [p + "half", p + "whalf"], [p + "win"]),
        helper.make_node("Cos", [p + "arg"], [p + "cos"]),
        helper.make_node("Sin", [p + "arg"], [p + "sin"]),
        helper.make_node("Neg", [p + "sin"], [p + "nsin"]),
        helper.make_node("Mul", [p + "cos", p + "win"], [p + "re"]),
        helper.make_node("Mul", [p + "nsin", p + "win"], [p + "im"]),
        helper.make_node("Reshape", [p + "re", p + "shape"], [real_name]),
        helper.make_node("Reshape", [p + "im", p + "shape"], [imag_name]),
    ]
    return inits, nodes


def to_fp16_storage(src: str, out: str, basis: str) -> dict:
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    m = onnx.load(src)
    g = m.graph
    real = next(i.name for i in g.initializer if i.name.endswith("conv_real.weight"))
    imag = next(i.name for i in g.initializer if i.name.endswith("conv_imag.weight"))
    keep, casts, stats = [], [], {"fp16": 0, "fp32": 0, "dropped": 0}
    ref_basis = {}
    for init in g.initializer:
        a = numpy_helper.to_array(init)
        if basis == "graph" and init.name in (real, imag):
            ref_basis[init.name] = a
            stats["dropped"] += a.size
            continue
        if init.data_type == TensorProto.FLOAT and (a.size >= SMALL) and not (basis == "fp32" and init.name in (real, imag)):
            h = a.astype(np.float16)
            if not np.all(np.isfinite(h)):
                sys.exit(f"{init.name} overflows float16")
            keep.append(numpy_helper.from_array(h, init.name + "__fp16"))
            casts.append(helper.make_node("Cast", [init.name + "__fp16"], [init.name], to=TensorProto.FLOAT, name="cast_" + init.name))
            stats["fp16"] += a.size
        else:
            keep.append(init)
            stats["fp32"] += a.size
    new_nodes = list(casts)
    if basis == "graph":
        b_inits, b_nodes = basis_nodes(real, imag)
        keep.extend(b_inits)
        new_nodes.extend(b_nodes)
    del g.initializer[:]
    g.initializer.extend(keep)
    old = list(g.node)
    del g.node[:]
    g.node.extend(new_nodes + old)
    m.producer_name = "piano2vision pti_export.py"
    m.doc_string = (
        "ByteDance high-resolution piano transcription note model (Kong et al. 2021), checkpoint "
        "CRNN_note_F1=0.9677_pedal_F1=0.9186.pth (zenodo.org/record/4034264, CC BY 4.0). Changes: converted "
        "to ONNX, weights stored as float16, STFT basis computed in the graph."
    )
    onnx.checker.check_model(m)
    onnx.save(m, out)
    if ref_basis:
        # the in-graph basis must equal torchlibrosa's (float64 maths cast to float32)
        import onnxruntime as ort

        probe = helper.make_model(
            helper.make_graph(
                b_nodes, "basis", [], [helper.make_tensor_value_info(n, TensorProto.FLOAT, None) for n in (real, imag)], b_inits
            ),
            opset_imports=[helper.make_opsetid("", 17)],
            ir_version=m.ir_version,
        )
        s = ort.InferenceSession(probe.SerializeToString(), providers=["CPUExecutionProvider"])
        got = s.run(None, {})
        stats["basis_max_abs_diff"] = float(max(np.abs(got[0] - ref_basis[real]).max(), np.abs(got[1] - ref_basis[imag]).max()))
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint")
    ap.add_argument("out")
    ap.add_argument("--fp32", help="also keep the float32 export here")
    ap.add_argument("--from-fp32", help="skip the (slow, ~5 min) PyTorch export: convert this float32 export")
    ap.add_argument("--basis", choices=["graph", "fp16", "fp32"], default="graph")
    ap.add_argument("--split", type=int, default=0, help="also write the file as N consecutive pieces")
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        fp32 = a.from_fp32 or a.fp32 or os.path.join(tmp, "fp32.onnx")
        if not a.from_fp32:
            export_fp32(a.checkpoint, fp32)
        stats = to_fp16_storage(fp32, a.out, a.basis)
    data = open(a.out, "rb").read()
    print(f"{a.out}: {len(data):,} bytes, sha256 {hashlib.sha256(data).hexdigest()}")
    print("values stored as float16 / float32 / computed:", stats["fp16"], stats["fp32"], stats["dropped"])
    if a.split > 0:
        step = -(-len(data) // a.split)
        stem = a.out[: -len(".onnx")] if a.out.endswith(".onnx") else a.out
        for k in range(a.split):
            piece = data[k * step: (k + 1) * step]
            path = f"{stem}.part{k + 1}.bin"
            open(path, "wb").write(piece)
            print(f"{path}: {len(piece):,} bytes")
    if "basis_max_abs_diff" in stats:
        print("in-graph STFT basis vs torchlibrosa: max abs diff %.2e" % stats["basis_max_abs_diff"])


if __name__ == "__main__":
    main()
