// SPDX-License-Identifier: AGPL-3.0-or-later
// Part of the homr sheet-music reader (see README.md here); written for Piano2Vision, 2026.
/**
 * Weights stored as float16, expanded back to float32 before onnxruntime sees the model.
 *
 * The shipped segmentation model keeps its large weights as float16 (half the download) and casts them
 * to float32 inside the graph (tests/homr/convert_models.py fp16_storage: initializer `X__fp16` +
 * node `Cast(X__fp16) -> X`). Measured in onnxruntime-web 1.31 (Node, 1 thread, session + two runs of
 * two 320 px windows): that model raised the process's peak memory by 425–449 MB, the float32 file (and
 * this rewrite of the float16 file) by 288 MB; onnxruntime folds the casts into new float32 constants
 * while the float16 ones are still loaded. Rewriting the model here
 * (float16 → float32 initializers under the original names, casts removed) gives exactly the float32
 * graph with the float16-rounded weights: the same numbers as running the casts, at the float32 file's
 * memory. Only plain protobuf is touched; anything unexpected returns the model unchanged.
 *
 * Original code (not derived from homr).
 */

const SUFFIX = '__fp16';
const FLOAT = 1;
const FLOAT16 = 10;

// ------------------------------------------------------------------ protobuf wire format

interface Field {
  no: number;
  wire: number;
  /** the whole field (key + value) in the source */
  start: number;
  end: number;
  /** length-delimited value (wire type 2) */
  vStart: number;
  vEnd: number;
  /** varint value (wire type 0) */
  num: number;
}

function readVarint(b: Uint8Array, p: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (;;) {
    if (p >= b.length) throw new Error('truncated');
    const x = b[p++];
    v += (x & 0x7f) * mul;
    if (x < 0x80) return [v, p];
    mul *= 128;
    if (mul > 2 ** 63) throw new Error('varint too long');
  }
}

function fields(b: Uint8Array, start: number, end: number): Field[] {
  const out: Field[] = [];
  let p = start;
  while (p < end) {
    const s = p;
    const [key, q] = readVarint(b, p);
    p = q;
    const no = Math.floor(key / 8);
    const wire = key % 8;
    let vStart = p;
    let vEnd = p;
    let num = 0;
    if (wire === 0) [num, p] = readVarint(b, p);
    else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else if (wire === 2) {
      const [len, r] = readVarint(b, p);
      vStart = r;
      vEnd = r + len;
      p = vEnd;
    } else throw new Error(`wire type ${wire}`);
    if (p > end) throw new Error('truncated');
    out.push({ no, wire, start: s, end: p, vStart, vEnd, num });
  }
  return out;
}

function varint(v: number): number[] {
  const out: number[] = [];
  while (v >= 128) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

/** Pieces of a message, joined once at the end (no big intermediate copies). */
type Piece = Uint8Array | number[];
const size = (ps: Piece[]) => ps.reduce((a, p) => a + p.length, 0);
const lenField = (no: number, body: Piece[]): Piece[] => [varint(no * 8 + 2), varint(size(body)), ...body];
const strBytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array, f: Field) => new TextDecoder().decode(b.subarray(f.vStart, f.vEnd));

// ------------------------------------------------------------------ float16

let HALF: Float32Array | null = null;
/** float32 value of every float16 bit pattern */
function halfTable(): Float32Array {
  if (HALF) return HALF;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return (HALF = t);
}

// ------------------------------------------------------------------ the rewrite

/** Is this NodeProto `Cast(<x>__fp16) -> <x>` to float32? Returns the cast's input name. */
function castInput(b: Uint8Array, node: Field): string | null {
  const fs = fields(b, node.vStart, node.vEnd);
  const op = fs.find((f) => f.no === 4 && f.wire === 2);
  if (!op || str(b, op) !== 'Cast') return null;
  const ins = fs.filter((f) => f.no === 1 && f.wire === 2);
  const outs = fs.filter((f) => f.no === 2 && f.wire === 2);
  if (ins.length !== 1 || outs.length !== 1) return null;
  const input = str(b, ins[0]);
  if (!input.endsWith(SUFFIX) || input.slice(0, -SUFFIX.length) !== str(b, outs[0])) return null;
  const to = fs
    .filter((f) => f.no === 5 && f.wire === 2)
    .map((a) => fields(b, a.vStart, a.vEnd))
    .find((a) => a.some((f) => f.no === 1 && f.wire === 2 && str(b, f) === 'to'));
  const i = to?.find((f) => f.no === 3 && f.wire === 0);
  return i && i.num === FLOAT ? input : null;
}

/** A float16 TensorProto (raw_data) named in `names` → the float32 TensorProto under the cast's output name, else null. */
function expandTensor(b: Uint8Array, t: Field, names: Set<string>): Piece[] | null {
  const fs = fields(b, t.vStart, t.vEnd);
  const name = fs.find((f) => f.no === 8 && f.wire === 2);
  if (!name || !names.has(str(b, name))) return null;
  const type = fs.find((f) => f.no === 2 && f.wire === 0);
  const raw = fs.find((f) => f.no === 9 && f.wire === 2);
  if (!type || type.num !== FLOAT16 || !raw || (raw.vEnd - raw.vStart) % 2) return null;
  // only dims, type, name and raw_data are expected (numpy_helper.from_array)
  if (fs.some((f) => ![1, 2, 8, 9].includes(f.no))) return null;
  const n = (raw.vEnd - raw.vStart) / 2;
  const half = halfTable();
  const out = new Float32Array(n);
  const dv = new DataView(b.buffer, b.byteOffset + raw.vStart, n * 2);
  for (let i = 0; i < n; i++) out[i] = half[dv.getUint16(2 * i, true)];
  const bytes = new Uint8Array(out.buffer);
  if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) return null; // big-endian host: keep the casts
  const keep: Piece[] = fs.filter((f) => f.no === 1).map((f) => b.subarray(f.start, f.end));
  return lenField(5, [...keep, [16, FLOAT], ...lenField(8, [strBytes(str(b, name).slice(0, -SUFFIX.length))]), ...lenField(9, [bytes])]);
}

/**
 * ONNX model bytes with `X__fp16` + `Cast → X` pairs turned back into float32 initializers `X`. Returns
 * the input itself when there is nothing to expand or the model does not look as expected.
 */
export function expandFp16Weights(model: Uint8Array): Uint8Array {
  try {
    const top = fields(model, 0, model.length);
    const graphs = top.filter((f) => f.no === 7 && f.wire === 2);
    if (graphs.length !== 1) return model;
    const g = graphs[0];
    const gf = fields(model, g.vStart, g.vEnd);
    const casts = new Map<Field, string>();
    for (const f of gf) {
      if (f.no !== 1 || f.wire !== 2) continue;
      const input = castInput(model, f);
      if (input) casts.set(f, input);
    }
    if (!casts.size) return model;
    const names = new Set(casts.values());
    // the cast inputs must not appear anywhere else (graph inputs, other nodes)
    for (const f of gf) if (f.no === 11 && f.wire === 2 && names.has(str(model, fields(model, f.vStart, f.vEnd).find((x) => x.no === 1) ?? f))) return model;
    const expanded = new Set<string>();
    const body: Piece[] = [];
    for (const f of gf) {
      if (casts.has(f)) continue;
      if (f.no === 5 && f.wire === 2) {
        const t = expandTensor(model, f, names);
        if (t) {
          const nm = fields(model, f.vStart, f.vEnd).find((x) => x.no === 8)!;
          expanded.add(str(model, nm));
          body.push(...t);
          continue;
        }
      }
      body.push(model.subarray(f.start, f.end));
    }
    // every removed cast needs its weights expanded, or the graph would lose an input
    if (expanded.size !== names.size) return model;
    const pieces: Piece[] = [];
    for (const f of top) pieces.push(...(f === g ? lenField(7, body) : [model.subarray(f.start, f.end)]));
    const out = new Uint8Array(size(pieces));
    let p = 0;
    for (const piece of pieces) {
      out.set(piece, p);
      p += piece.length;
    }
    return out;
  } catch {
    return model;
  }
}
