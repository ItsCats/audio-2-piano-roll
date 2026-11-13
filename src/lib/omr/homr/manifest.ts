// Written by tests/homr/package_models.py: the shipped model files (public/models/homr/).
export const HOMR_MODELS = {
  "segnet": {
    "file": "segnet.fp16w.onnx",
    "bytes": 28682926,
    "sha256": "2ec66392e051b38e3f74d6fb98959e485243bc320258d133514b1d5fbea66f80",
    "parts": [
      "models/homr/segnet.fp16w.part1.bin",
      "models/homr/segnet.fp16w.part2.bin",
      "models/homr/segnet.fp16w.part3.bin",
      "models/homr/segnet.fp16w.part4.bin"
    ]
  },
  "encoder": {
    "file": "encoder.int8.onnx",
    "bytes": 17142614,
    "sha256": "df016c4ee93f69a168d2368b14703ca03ea507514b50d1d78369acc07d9761e3",
    "parts": [
      "models/homr/encoder.int8.part1.bin",
      "models/homr/encoder.int8.part2.bin"
    ]
  },
  "decoder": {
    "file": "decoder.int8.onnx",
    "bytes": 47356003,
    "sha256": "99a6ac39770616bc1a20d6c409bb85fbbe21ba47f972984f9ef834fb5741b96f",
    "parts": [
      "models/homr/decoder.int8.part1.bin",
      "models/homr/decoder.int8.part2.bin",
      "models/homr/decoder.int8.part3.bin",
      "models/homr/decoder.int8.part4.bin",
      "models/homr/decoder.int8.part5.bin"
    ]
  }
} as const;
