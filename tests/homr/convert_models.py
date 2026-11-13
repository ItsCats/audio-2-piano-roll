"""
Smaller variants of homr's ONNX models for the in-browser reader (src/lib/omr/homr).

homr 0.7.1 ships float32 ONNX files (segmentation 57 MB, encoder 53 MB, decoder 47 MB, AGPL-3.0,
https://github.com/liebharc/homr). This writes, per model:

  <name>.fp16w.onnx  weights STORED as float16 and cast to float32 inside the graph (one Cast per
                     initializer, constant-folded by onnxruntime when the session is created), so the
                     WASM backend still runs float32 kernels; half the size. Initializers under 1024
                     values (biases, norms) stay float32.
  <name>.int8.onnx   onnxruntime dynamic quantisation (int8 weights; MatMul -> MatMulInteger,
                     Conv -> ConvInteger), about a quarter of the size.

tests/homr/eval_python.py measures which variant keeps the notes (notes F1 within 0.01 of float32).

usage: python convert_models.py <homr package dir> <out dir>
"""

from __future__ import annotations

import hashlib
import os
import sys

import numpy as np

SMALL = 1024


def fp16_storage(src: str, out: str) -> None:
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    m = onnx.load(src)
    g = m.graph
    keep, casts = [], []
    for init in g.initializer:
        a = numpy_helper.to_array(init)
        if init.data_type == TensorProto.FLOAT and a.size >= SMALL:
            h = a.astype(np.float16)
            if not np.all(np.isfinite(h)):
                raise SystemExit(f"{init.name} overflows float16")
            keep.append(numpy_helper.from_array(h, init.name + "__fp16"))
            casts.append(
                helper.make_node(
                    "Cast", [init.name + "__fp16"], [init.name], to=TensorProto.FLOAT, name="cast_" + init.name
                )
            )
        else:
            keep.append(init)
    del g.initializer[:]
    g.initializer.extend(keep)
    old = list(g.node)
    del g.node[:]
    g.node.extend(casts + old)
    onnx.save(m, out)


def int8_dynamic(src: str, out: str, ops: list[str] | None = None) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(src, out, weight_type=QuantType.QInt8, op_types_to_quantize=ops)


def sha(path: str) -> str:
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main() -> None:
    pkg, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    sources = {
        "segnet": os.path.join(pkg, "segmentation", "segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx"),
        "encoder": os.path.join(pkg, "transformer", "encoder_pytorch_model_509-2293bba14bfea47d9d28411339362af15fce4c31.onnx"),
        "decoder": os.path.join(pkg, "transformer", "decoder_pytorch_model_509-2293bba14bfea47d9d28411339362af15fce4c31.onnx"),
    }
    for name, src in sources.items():
        fp16 = os.path.join(out_dir, f"{name}.fp16w.onnx")
        fp16_storage(src, fp16)
        print(name, "fp16w", os.path.getsize(fp16), sha(fp16))
        i8 = os.path.join(out_dir, f"{name}.int8.onnx")
        # Convolutions only on request: ConvInteger is slow in onnxruntime-web's WASM kernels
        int8_dynamic(src, i8, ["MatMul", "Gemm"] if name != "segnet" else None)
        print(name, "int8", os.path.getsize(i8), sha(i8))


if __name__ == "__main__":
    main()
