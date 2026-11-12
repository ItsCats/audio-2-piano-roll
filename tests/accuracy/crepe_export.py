"""
Export the CREPE "tiny" pitch model (torchcrepe 0.0.24 weights, MIT) to ONNX for the browser.

    server/.venv/bin/python tests/accuracy/crepe_export.py public/models/crepe/crepe-tiny.onnx [--fp16]

Graph: input "frames" [N, 1024] float32 (16 kHz frames, each mean-centred and divided by its
standard deviation, as torchcrepe.preprocess does) -> output "probs" [N, 360] float32 (sigmoid
activations of the 360 pitch bins, 20 cents apart, bin 0 = 1997.38 cents above 10 Hz ~ 31.7 Hz).

The 2-D convolutions with (k, 1) kernels are rewritten as 1-D convolutions (identical maths,
simpler graph for the WASM backend). The script checks the export against torchcrepe on random
and harmonic input and prints the file's sha256.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys

import numpy as np


def build(fp16: bool):
    import torch
    import torch.nn.functional as F
    import torchcrepe

    ref = torchcrepe.Crepe("tiny")
    p = os.path.join(os.path.dirname(torchcrepe.__file__), "assets", "tiny.pth")
    ref.load_state_dict(torch.load(p, map_location="cpu", weights_only=True))
    ref.eval()

    class Crepe1d(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.convs = torch.nn.ModuleList()
            self.bns = torch.nn.ModuleList()
            for i in range(1, 7):
                c2 = getattr(ref, f"conv{i}")
                c1 = torch.nn.Conv1d(c2.in_channels, c2.out_channels, c2.kernel_size[0], c2.stride[0])
                c1.weight.data = c2.weight.data[..., 0].clone()
                c1.bias.data = c2.bias.data.clone()
                bn2 = getattr(ref, f"conv{i}_BN")
                bn1 = torch.nn.BatchNorm1d(bn2.num_features, eps=bn2.eps)
                bn1.load_state_dict(bn2.state_dict())
                self.convs.append(c1)
                self.bns.append(bn1)
            self.classifier = ref.classifier
            self.in_features = ref.in_features

        def forward(self, frames):
            x = frames[:, None, :]
            for i, (c, bn) in enumerate(zip(self.convs, self.bns)):
                x = F.pad(x, (254, 254) if i == 0 else (31, 32))
                x = bn(F.relu(c(x)))
                x = F.max_pool1d(x, 2, 2)
            # torchcrepe: (B, C, T, 1).permute(0, 2, 1, 3) -> (B, T, C) flattened
            x = x.permute(0, 2, 1).reshape(-1, self.in_features)
            return torch.sigmoid(self.classifier(x))

    m = Crepe1d().eval()
    if fp16:
        m = m.half()
    return ref, m


def main() -> None:
    import onnx
    import onnxruntime as ort
    import torch

    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--fp16", action="store_true", help="store weights as float16 (graph casts at the input/output)")
    a = ap.parse_args()
    ref, m = build(False)
    x = torch.randn(64, 1024)
    t = torch.arange(1024) / 16000
    harm = sum(torch.sin(2 * np.pi * k * 220 * t) / k for k in range(1, 6))
    x[0] = (harm - harm.mean()) / harm.std()
    with torch.no_grad():
        y_ref = ref(x).numpy()
        y_1d = m(x).numpy()
    print("1-d rewrite max abs diff vs torchcrepe:", float(np.abs(y_ref - y_1d).max()))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    torch.onnx.export(m, (x,), a.out, input_names=["frames"], output_names=["probs"],
                      dynamic_axes={"frames": {0: "n"}, "probs": {0: "n"}}, opset_version=17, dynamo=False)
    model = onnx.load(a.out)
    if a.fp16:
        from onnxruntime.transformers.float16 import convert_float_to_float16
        model = convert_float_to_float16(model, keep_io_types=True)
    onnx.save(model, a.out)
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    s = ort.InferenceSession(a.out, so, providers=["CPUExecutionProvider"])
    y_onnx = s.run(None, {"frames": x.numpy()})[0]
    print("onnx max abs diff vs torchcrepe:", float(np.abs(y_ref - y_onnx).max()),
          "argmax agreement:", float((y_ref.argmax(1) == y_onnx.argmax(1)).mean()))
    print("harmonic 220 Hz frame argmax bin:", int(y_onnx[0].argmax()), "(expected ~",
          round((1200 * np.log2(220 / 10) - 1997.3794084376191) / 20), ")")
    b = open(a.out, "rb").read()
    print("bytes", len(b), "sha256", hashlib.sha256(b).hexdigest())


if __name__ == "__main__":
    sys.exit(main())
