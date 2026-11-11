import { describe, expect, it } from 'vitest';
import { batchFor, chooseBackendOrder, isAppleMobile, isMemoryConstrained } from '../../src/lib/transcription/backendOrder';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const gpu = { softwareRenderer: false, offscreen: true };

describe('chooseBackendOrder', () => {
  it('never uses WebGL on an iPhone (its texture memory crashes the Safari tab)', () => {
    expect(chooseBackendOrder({ ua: IPHONE, maxTouchPoints: 5, ...gpu })).toEqual(['wasm', 'cpu']);
  });
  it('detects iPadOS, which presents a Mac user agent, by its touch points', () => {
    expect(isAppleMobile(IPAD_DESKTOP_UA, 5)).toBe(true);
    expect(isAppleMobile(IPAD_DESKTOP_UA, 0)).toBe(false);
    expect(chooseBackendOrder({ ua: IPAD_DESKTOP_UA, maxTouchPoints: 5, ...gpu })[0]).toBe('wasm');
  });
  it('uses wasm on Android phones and low-memory devices', () => {
    expect(chooseBackendOrder({ ua: ANDROID, maxTouchPoints: 5, ...gpu })[0]).toBe('wasm');
    expect(isMemoryConstrained({ ua: DESKTOP_CHROME, deviceMemory: 4 })).toBe(true);
    expect(chooseBackendOrder({ ua: DESKTOP_CHROME, deviceMemory: 4, ...gpu })).not.toContain('webgl');
  });
  it('keeps WebGL first on a desktop with a real GPU, wasm next', () => {
    expect(chooseBackendOrder({ ua: DESKTOP_CHROME, deviceMemory: 8, ...gpu })).toEqual(['webgl', 'wasm', 'cpu']);
  });
  it('skips a software WebGL renderer but keeps it as a late fallback on desktop', () => {
    expect(chooseBackendOrder({ ua: DESKTOP_CHROME, softwareRenderer: true, offscreen: true })).toEqual(['wasm', 'webgl', 'cpu']);
  });
  it('honours an explicit preference first', () => {
    expect(chooseBackendOrder({ ua: IPHONE, maxTouchPoints: 5, ...gpu }, 'cpu')).toEqual(['cpu', 'wasm']);
  });
  it('keeps WebGL batches small', () => {
    expect(batchFor('webgl')).toBeLessThanOrEqual(2);
    expect(batchFor('cpu')).toBe(1);
  });
});
