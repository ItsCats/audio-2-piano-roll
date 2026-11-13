// SPDX-License-Identifier: AGPL-3.0-or-later
// Part of the homr sheet-music reader (see README.md here); written for Piano2Vision, 2026.
/**
 * What the homr reader needs and how long it takes here (download size, memory, time per page), without
 * loading the reader itself: the import screen shows these before anything is downloaded. index.ts
 * re-exports all of it.
 */
import { isMemoryConstrained, isPhoneOrTablet, pageDeviceInfo, type DeviceInfo } from '../../transcription/backendChoice';
import { wasmThreads } from '../../isolation';
import { HOMR_MODELS } from './manifest';

/** Most pages read in one go. */
export const MAX_PAGES = 20;
/** Most pages in one go on a phone or tablet (2–4.5 minutes each there). */
export const MAX_PAGES_PHONE = 5;
/**
 * Extra browser memory while reading, MB (desktops: all three networks kept loaded). Measured
 * 2026-11-13 in headless Chromium on a production build (public/models/homr/README.md): the whole
 * browser's PSS grows by 0.97–1.08 GB on the first page (download included), the tab's renderer process
 * (which holds the worker) peaks 0.9–1.0 GB above its idle size; an earlier run saw +1.36 GB on one
 * synthetic photo.
 */
export const HOMR_EXTRA_MB = 1200;
/**
 * The same in low-memory mode (phones: one network at a time, one thread, one window per run): the
 * renderer's peak is only ~2–15 % lower (the encoder + decoder step alone needs ~500 MB of WASM memory),
 * but the memory goes back right after the job.
 */
export const HOMR_EXTRA_MB_LOW = 1100;
/**
 * Seconds per page of 3–4 systems by WASM threads (index = threads), headless Chromium on a shared
 * 4-core machine: 1 thread 48–80 s, 3 threads 32–59 s for pages of 2–5 systems.
 */
const SECONDS_PER_PAGE = [65, 65, 55, 45, 40];
/** Phones are assumed ~3x slower than one desktop thread. */
export const PHONE_SLOWDOWN = 3;

export function estimateSecondsPerPage(threads: number, phone = false): number {
  if (phone) return SECONDS_PER_PAGE[1] * PHONE_SLOWDOWN;
  return SECONDS_PER_PAGE[Math.max(1, Math.min(SECONDS_PER_PAGE.length - 1, Math.round(threads)))];
}

/** Download size of the models, bytes. */
export function homrDownloadBytes(): number {
  return HOMR_MODELS.segnet.bytes + HOMR_MODELS.encoder.bytes + HOMR_MODELS.decoder.bytes;
}

export interface ReaderSupport {
  available: boolean;
  recommended: boolean;
  reason?: string;
  downloadMB: number;
  memoryMB: number;
  estSecondsPerPage: number;
  threads: number;
  phone: boolean;
  /** most pages per job here */
  maxPages: number;
}

// a tiny module using a v128 instruction: onnxruntime-web 1.31 ships SIMD builds only
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
function hasSimd(): boolean {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

/** Can the homr reader run here, and is it a good idea? */
export function homrReaderSupport(deviceIn?: DeviceInfo | string, threadsIn?: number, env: { worker?: boolean; simd?: boolean } = {}): ReaderSupport {
  // also callable like the SMT reader's sheetReaderSupport(kind): a kind string is ignored here
  const device = typeof deviceIn === 'object' ? deviceIn : pageDeviceInfo();
  const phone = device ? isPhoneOrTablet(device) : false;
  const constrained = device ? isMemoryConstrained(device) : false;
  const threads = constrained ? 1 : (threadsIn ?? wasmThreads(4));
  const base = {
    downloadMB: Math.round(homrDownloadBytes() / 1e6),
    memoryMB: constrained ? HOMR_EXTRA_MB_LOW : HOMR_EXTRA_MB,
    estSecondsPerPage: estimateSecondsPerPage(threads, phone),
    threads,
    phone,
    maxPages: phone ? MAX_PAGES_PHONE : MAX_PAGES,
  };
  if (!(env.worker ?? typeof Worker !== 'undefined')) return { ...base, available: false, recommended: false, reason: 'This browser cannot run the sheet-music reader (no Web Worker support).' };
  if (!(env.simd ?? hasSimd())) return { ...base, available: false, recommended: false, reason: 'This browser is too old for the sheet-music reader (it needs WebAssembly SIMD).' };
  if (constrained) {
    return {
      ...base,
      available: true,
      recommended: false,
      reason: phone
        ? `Reading sheet music on a phone is slow (about ${Math.round(base.estSecondsPerPage / 60)} minutes per page, at most ${MAX_PAGES_PHONE} pages at a time) and needs about ${base.memoryMB} MB of memory. Close other apps and tabs first; a computer is much faster.`
        : `This device reports little memory; reading sheet music needs about ${base.memoryMB} MB.`,
    };
  }
  return { ...base, available: true, recommended: true };
}

