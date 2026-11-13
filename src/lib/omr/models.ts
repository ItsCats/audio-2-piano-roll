/**
 * Shipped sheet-music reader model files (public/models/omr/, README.md there). Generated from the
 * export with the research scripts; each file is split into pieces under 10 MB (Netlify) and joined
 * and sha256-checked in the worker.
 */
import type { ModelFile, ModelSpec } from './protocol';

interface Shipped {
  variant: string;
  encoder: { file: string; bytes: number; sha256: string; parts: string[] };
  decoder: { file: string; bytes: number; sha256: string; parts: string[] };
}

export const VOCAB = {"bytes": 180872, "sha256": "b7febe066e23191332e24ed3867a9632c0d8e6d9a8353629f54177a74308ecf4", "path": "models/omr/vocab.json"} as const;

export const SHIPPED: Record<string, Shipped> = {
  "smt-camera-grandstaff": {
    "variant": "int8",
    "encoder": {
      "file": "encoder.int8.onnx",
      "bytes": 6935635,
      "sha256": "4538160e18f240c2fd44dee6165a23c2c0a1960725a0b34e87b6b05ddafbdf28",
      "parts": [
        "models/omr/smt-camera-grandstaff/encoder.int8.part1.bin"
      ]
    },
    "decoder": {
      "file": "decoder.int8.onnx",
      "bytes": 16405521,
      "sha256": "568f78b6bedaa3b807a1418c1ffa19b3f97d6fb9873224598a8bc127db5ad217",
      "parts": [
        "models/omr/smt-camera-grandstaff/decoder.int8.part1.bin",
        "models/omr/smt-camera-grandstaff/decoder.int8.part2.bin"
      ]
    }
  }
};

/** Absolute URLs (with ?v=<sha256 prefix> so a new model never meets an old HTTP cache entry). */
export function modelSpec(name: string, base: string): ModelSpec | null {
  const s = SHIPPED[name];
  if (!s) return null;
  const file = (f: { file: string; bytes: number; sha256: string; parts: string[] }, dir: string): ModelFile => {
    const v = `?v=${f.sha256.slice(0, 8)}`;
    return { url: new URL(`${dir}${f.file}${v}`, base).href, parts: f.parts.map((p) => new URL(`${p}${v}`, base).href), sha256: f.sha256, bytes: f.bytes };
  };
  const dir = `models/omr/${name}/`;
  return {
    name,
    encoder: file(s.encoder, dir),
    decoder: file(s.decoder, dir),
    vocab: { url: new URL(`${VOCAB.path}?v=${VOCAB.sha256.slice(0, 8)}`, base).href, sha256: VOCAB.sha256, bytes: VOCAB.bytes },
  };
}

/** Download size of a model in bytes (vocabulary included). */
export function modelBytes(name: string): number {
  const s = SHIPPED[name];
  return s ? s.encoder.bytes + s.decoder.bytes + VOCAB.bytes : 0;
}
