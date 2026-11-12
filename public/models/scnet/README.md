# SCNet source-separation model (int8 ONNX)

`scnet.int8.onnx` splits a song into drums, bass, other and vocals. Piano2Vision runs it in the browser
(onnxruntime-web, WASM) for the import option "Separate vocals & drums": the vocal stem gives the right-hand
melody, bass + other (no drums, no vocals) is transcribed as the accompaniment. Code: `src/lib/separation/`.

| | |
|---|---|
| File | `scnet.int8.onnx`, 12,900,277 bytes |
| SHA-256 | `98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845` |
| Source | https://huggingface.co/audiojs/scnet/resolve/e71bcdb42bce1d62b7fae25ba90fcbcf90f73f46/scnet.int8.onnx |
| Revision | `e71bcdb42bce1d62b7fae25ba90fcbcf90f73f46` of huggingface.co/audiojs/scnet |
| Model | SCNet by starrytong, https://github.com/starrytong/SCNet (MIT), checkpoint `scnet_checkpoint_musdb18.ckpt` as distributed by ZFTurbo/Music-Source-Separation-Training v.1.0.6 (MIT) |
| ONNX export / int8 compaction | audiojs (https://github.com/audiojs/neural, `@audio/neural-separate`) |
| Licence | MIT, Copyright (c) 2024 starrytong; see [LICENSE](LICENSE) |

Graph: input `mix_spec` [1, 4, 2049, 476] (STFT of 11 s of 44.1 kHz stereo: n_fft 4096, hop 1024, no window,
scaled by 1/sqrt(4096), centred with reflect padding; L re, L im, R re, R im), output `stems_spec`
[1, 16, 2049, 476] (drums, bass, other, vocals x L/R x re/im). The STFT/iSTFT and segmenting run in JavaScript.

Redistribution: the weights' author confirmed in https://github.com/starrytong/SCNet/issues/35 (2026-07-17):

> I confirm that the released SCNet and SCNet-large pretrained weights are distributed under the MIT License,
> consistent with the source code. You are welcome to redistribute the original checkpoints and format-converted
> versions, including ONNX exports, as part of your MIT-licensed tool, with appropriate attribution.

The model was trained on MUSDB18-HQ (Rafii et al., 2019).

## Citation

```bibtex
@inproceedings{tong2024scnet,
  title     = {SCNet: Sparse Compression Network for Music Source Separation},
  author    = {Tong, Weinan and Zhu, Jiaxu and Chen, Jun and Kang, Shiyin and Jiang, Tao and Li, Yang and Wu, Zhiyong and Meng, Helen},
  booktitle = {IEEE International Conference on Acoustics, Speech and Signal Processing (ICASSP)},
  year      = {2024},
  eprint    = {2401.13276},
  archivePrefix = {arXiv}
}
```
