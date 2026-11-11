# CREPE "tiny" pitch model (ONNX)

`crepe-tiny.onnx` is a monophonic pitch tracker. Piano2Vision can run it in the browser
(onnxruntime-web, WASM) on the separated vocal stem to get the sung melody line
(`src/lib/pitch/`, `trackVocalPitch()`).

| | |
|---|---|
| File | `crepe-tiny.onnx`, 1,962,678 bytes, float32 weights |
| SHA-256 | `4d10f6f519aa15936c8b179e8a6c1f6ce3ea3683ddeea7ee6e3ee5549de7242f` |
| Source weights | `torchcrepe/assets/tiny.pth` from torchcrepe 0.0.24 (PyPI, https://github.com/maxrmorrison/torchcrepe), sha256 `d4993eea36ed1a0ad9ac549c740dae5265b049ce72004f00c2f59e01c0be8432` |
| Origin of those weights | the "tiny" model of CREPE by Jong Wook Kim et al. (https://github.com/marl/crepe, `model-tiny.h5`), converted to PyTorch by the torchcrepe author with MMdnn |
| Export | `server/.venv/bin/python tests/accuracy/crepe_export.py public/models/crepe/crepe-tiny.onnx` (opset 17; the (k, 1) Conv2d layers rewritten as Conv1d — identical maths; max abs difference to torchcrepe 3e-7, same argmax on every test frame) |
| Licence | MIT — Copyright (c) 2018 Jong Wook Kim (CREPE) and Copyright (c) 2020 Max Morrison (torchcrepe); see [LICENSE](LICENSE) |

Licence check (2026-11-11): marl/crepe is MIT (LICENSE in the repository, `license='MIT'` in its
setup.py, which downloads the weight files from the same repository's `models` branch); torchcrepe is
MIT (its LICENSE, PyPI metadata "License :: OSI Approved :: MIT License") and ships the converted
weights inside the MIT-licensed package. Neither project states a separate licence for the weights, so
they are distributed under the repositories' MIT licences. CREPE was trained on MIR-1K, Bach10,
RWC-Synth, MedleyDB, MDB-STEM-Synth and NSynth (Kim et al. 2018).

Graph: input `frames` [N, 1024] float32 — 1024-sample frames of 16 kHz audio, each mean-centred and
divided by its (unbiased) standard deviation; output `probs` [N, 360] float32 — sigmoid activations of
360 pitch bins, 20 cents apart, bin 0 = 1997.38 cents above 10 Hz (≈ 31.7 Hz). Resampling, framing,
Viterbi decoding (torchcrepe's transition matrix) and the voicing gate run in TypeScript
(`src/lib/pitch/crepe.ts`). The model is convolutional only, so the float32 file (≈ 2 MB) is kept;
a float16 copy (≈ 1 MB) would need fp16 kernels the WASM backend does not have.

## Citation

```bibtex
@inproceedings{kim2018crepe,
  title     = {CREPE: A Convolutional Representation for Pitch Estimation},
  author    = {Kim, Jong Wook and Salamon, Justin and Li, Peter and Bello, Juan Pablo},
  booktitle = {IEEE International Conference on Acoustics, Speech and Signal Processing (ICASSP)},
  pages     = {161--165},
  year      = {2018}
}
```
