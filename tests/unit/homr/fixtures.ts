import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** Fixtures written by tests/homr/make_fixtures.py (cv2 results for generated inputs). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadCvFixtures(): any {
  return JSON.parse(readFileSync(new URL('./fixtures/cv.json', import.meta.url), 'utf8'));
}

/** base64(zlib(bytes)) → bytes */
export function unpack(s: string): Uint8Array {
  return new Uint8Array(inflateSync(Buffer.from(s, 'base64')));
}
