"""Export a Sheet Music Transformer checkpoint (Hugging Face: model.safetensors + config.json) to the two
ONNX graphs the sheet-music reader runs in onnxruntime-web (src/lib/omr/worker.ts):
  encoder.onnx : image [1,1,H,W] (0..1 grayscale) -> cross_k, cross_v  [L,4,N,64] (per-layer cross-attention K/V)
  decoder.onnx : token [1,1] int64, pos [1] int64, past_k/past_v [L,4,T,64], cross_k, cross_v
                 -> logits [1,V], next_k/next_v [L,4,T+1,64]
plus encoder.int8.onnx / decoder.int8.onnx (dynamic 8-bit weights, what the app ships) and vocab.json
(token id -> bekern token). public/models/omr/README.md says how they were split for hosting.

python export_smt.py MODEL_DIR OUT_DIR      (torch 2.9, onnx 1.23, onnxruntime 1.31, transformers 4.57)
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).parent))
from smt_arch import SMT  # noqa: E402

model_dir, out_dir = sys.argv[1], Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)
m = SMT.load(model_dir)


class Enc(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, x):
        cross = self.m.encode(x)
        k = torch.stack([c[0][0] for c in cross])
        v = torch.stack([c[1][0] for c in cross])
        return k, v


class Dec(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, token, pos, past_k, past_v, cross_k, cross_v):
        h = self.m.embedding(token) + self.m.pe1[pos].unsqueeze(0)
        nk, nv = [], []
        for j, L in enumerate(self.m.layers):
            h, (k, v) = L.step(h, (past_k[j:j + 1], past_v[j:j + 1]), cross_k[j:j + 1], cross_v[j:j + 1])
            nk.append(k[0])
            nv.append(v[0])
        hh = torch.relu(h[:, -1]) if self.m.legacy else h[:, -1]
        return self.m.vocab_projection(hh), torch.stack(nk), torch.stack(nv)


enc, dec = Enc(m).eval(), Dec(m).eval()
nL = len(m.layers)
x = torch.rand(1, 1, 256, 1024)
with torch.no_grad():
    ck, cv = enc(x)
torch.onnx.export(enc, (x,), out_dir / 'encoder.onnx', input_names=['image'], output_names=['cross_k', 'cross_v'],
                  dynamic_axes={'image': {2: 'H', 3: 'W'}, 'cross_k': {2: 'N'}, 'cross_v': {2: 'N'}}, opset_version=17,
                  dynamo=False)
pk = torch.zeros(nL, 4, 0, 64)
torch.onnx.export(dec, (torch.tensor([[1]]), torch.tensor([0]), pk, pk, ck, cv), out_dir / 'decoder.onnx',
                  input_names=['token', 'pos', 'past_k', 'past_v', 'cross_k', 'cross_v'],
                  output_names=['logits', 'next_k', 'next_v'],
                  dynamic_axes={'past_k': {2: 'T'}, 'past_v': {2: 'T'}, 'cross_k': {2: 'N'}, 'cross_v': {2: 'N'},
                                'next_k': {2: 'T1'}, 'next_v': {2: 'T1'}}, opset_version=17, dynamo=False)

from onnxruntime.quantization import QuantType, quantize_dynamic  # noqa: E402

for n in ('encoder', 'decoder'):
    quantize_dynamic(str(out_dir / f'{n}.onnx'), str(out_dir / f'{n}.int8.onnx'), weight_type=QuantType.QUInt8)
i2w = [m.cfg['i2w'][str(i)] for i in range(len(m.cfg['i2w']))]
(out_dir / 'vocab.json').write_text(json.dumps(i2w, ensure_ascii=False, separators=(',', ':')))
for f in sorted(out_dir.glob('*.onnx')):
    print(f.name, round(f.stat().st_size / 1e6, 1), 'MB')
