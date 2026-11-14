/**
 * MediaRecorder writes WebM files without a duration (it doesn't know it when the file starts), so many
 * players show no length and can't scrub them. This adds the Duration element to the file's Info
 * section, the only change; the rest of the file is reused as it is (no copy of the video).
 *
 * Only the layout MediaRecorder writes is handled: EBML header, then a Segment of unknown size (written
 * while recording) whose Info comes before any SeekHead, Cues or Cluster, so no position stored in the
 * file moves. Anything else is left as it is.
 */

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_SEEKHEAD = 0x114d9b74;
const ID_CLUSTER = 0x1f43b675;
const ID_CUES = 0x1c53bb6b;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

/** how much of the file's start is read to find the Info section */
const HEAD_BYTES = 64 * 1024;

interface Vint {
  value: number;
  length: number;
  /** a size written as "unknown" (all value bits set) */
  unknown: boolean;
}

/** an element ID (the length marker is kept, as IDs are written) */
function readId(b: Uint8Array, at: number): Vint | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23; // 1..8 for a non-zero byte
  if (length > 4 || at + length > b.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + b[at + i];
  return { value, length, unknown: false };
}

/** an element's size (the length marker removed) */
function readSize(b: Uint8Array, at: number): Vint | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || at + length > b.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[at + i];
    if (b[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

/** a size written in 8 bytes (room for anything a file can hold) */
function size8(n: number): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function readUint(b: Uint8Array, at: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[at + i];
  return v;
}

/**
 * The parts of a WebM file with `seconds` as its duration, or null when the file isn't laid out as
 * expected or already has one. Pure (for the unit test): `head` is the file's first bytes.
 */
export function webmDurationPatch(head: Uint8Array, seconds: number): { cut: [number, number]; insert: Uint8Array<ArrayBuffer> } | null {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return null;
  const ebml = readId(head, 0);
  if (!ebml || ebml.value !== 0x1a45dfa3) return null;
  const ebmlSize = readSize(head, ebml.length);
  if (!ebmlSize || ebmlSize.unknown) return null;
  let at = ebml.length + ebmlSize.length + ebmlSize.value;
  const seg = readId(head, at);
  if (!seg || seg.value !== ID_SEGMENT) return null;
  const segSize = readSize(head, at + seg.length);
  // a Segment of known size may end with Cues, whose positions would move
  if (!segSize || !segSize.unknown) return null;
  at += seg.length + segSize.length;
  // the Segment's children, up to Info
  for (;;) {
    const id = readId(head, at);
    if (!id) return null;
    const size = readSize(head, at + id.length);
    if (!size || size.unknown) return null;
    const bodyAt = at + id.length + size.length;
    if (id.value === ID_SEEKHEAD || id.value === ID_CLUSTER || id.value === ID_CUES) return null;
    if (id.value !== ID_INFO) {
      at = bodyAt + size.value;
      continue;
    }
    const bodyEnd = bodyAt + size.value;
    if (bodyEnd > head.length) return null;
    let scale = 1e6;
    for (let p = bodyAt; p < bodyEnd; ) {
      const cid = readId(head, p);
      if (!cid) return null;
      const cs = readSize(head, p + cid.length);
      if (!cs || cs.unknown) return null;
      const cAt = p + cid.length + cs.length;
      if (cid.value === ID_DURATION) return null; // it has one already
      if (cid.value === ID_TIMECODE_SCALE && cs.value >= 1 && cs.value <= 8) scale = readUint(head, cAt, cs.value) || 1e6;
      p = cAt + cs.value;
    }
    const duration = new Uint8Array(11);
    duration.set([0x44, 0x89, 0x88]);
    new DataView(duration.buffer).setFloat64(3, (seconds * 1e9) / scale);
    const idBytes = head.subarray(at, at + id.length);
    const body = head.subarray(bodyAt, bodyEnd);
    const insert = new Uint8Array(id.length + 8 + body.length + duration.length);
    insert.set(idBytes, 0);
    insert.set(size8(body.length + duration.length), id.length);
    insert.set(body, id.length + 8);
    insert.set(duration, id.length + 8 + body.length);
    return { cut: [at, bodyEnd], insert };
  }
}

/** `blob` with its duration written in (the same blob when that isn't possible). */
export async function withWebmDuration(blob: Blob, seconds: number): Promise<Blob> {
  try {
    const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
    const patch = webmDurationPatch(head, seconds);
    if (!patch) return blob;
    return new Blob([head.slice(0, patch.cut[0]), patch.insert, blob.slice(patch.cut[1])], { type: blob.type });
  } catch {
    return blob;
  }
}
