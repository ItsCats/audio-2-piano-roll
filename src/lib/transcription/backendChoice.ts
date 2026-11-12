/**
 * Which TensorFlow.js backend the transcription worker tries first, as a pure function of the
 * device (unit-tested; the worker only gathers the inputs).
 *
 * Phones and tablets run Basic Pitch on WASM. On TF.js's WebGL backend the model's 3×39 convolution
 * builds an im2col matrix of ~170 MB per 2-second window and the texture pool reached 1.8–2.7 GB
 * whatever the recording's length (measured in Chromium with WebGL forced). iOS Safari has had WebGL
 * in worker OffscreenCanvas since iOS 17 ("Apple GPU" is not a software renderer), so it took that
 * path, went over the tab's memory budget and Safari reloaded the page mid-analysis. WASM needs no
 * GPU memory at all and is fast enough there (a 3-minute recording in ~21 s on a throttled Pixel 7).
 *
 * Desktops keep WebGL first (faster on a real GPU), always with the memory-safe settings below.
 */

export type TfBackend = 'webgl' | 'wasm' | 'cpu';

export interface BackendEnv {
  /** navigator.userAgent of the page */
  ua: string;
  /** navigator.maxTouchPoints of the page (WorkerNavigator has none: the page passes it) */
  maxTouchPoints?: number;
  /** navigator.deviceMemory (Chromium only; Safari and Firefox report nothing) */
  deviceMemory?: number;
  /** navigator.userAgentData.mobile (Chromium only) */
  mobile?: boolean;
  /** the WebGL renderer is a software one (SwiftShader, llvmpipe, …) */
  softwareRenderer: boolean;
  /** OffscreenCanvas exists in the worker (needed for WebGL there) */
  offscreen: boolean;
}

/** Device facts the page sends to the worker (the worker cannot read maxTouchPoints itself). */
export interface DeviceInfo {
  ua: string;
  maxTouchPoints?: number;
  deviceMemory?: number;
  mobile?: boolean;
}

/** The page's device facts (main thread). */
export function pageDeviceInfo(): DeviceInfo | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } };
  return { ua: nav.userAgent ?? '', maxTouchPoints: nav.maxTouchPoints ?? 0, deviceMemory: nav.deviceMemory, mobile: nav.userAgentData?.mobile };
}

/** iPhone, iPad or iPod: an iPad in desktop mode reports itself as a Mac with a touch screen. */
export function isAppleMobile(ua: string, maxTouchPoints = 0): boolean {
  return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/** Phones and tablets (whatever memory they report): their processors are also much slower than a desktop's. */
export function isPhoneOrTablet(env: Pick<BackendEnv, 'ua' | 'maxTouchPoints' | 'mobile'>): boolean {
  if (isAppleMobile(env.ua, env.maxTouchPoints)) return true;
  if (env.mobile) return true;
  return /Android|Mobile|Silk|Kindle|Tablet/i.test(env.ua);
}

/** Phones, tablets and devices that report 4 GB of memory or less. */
export function isMemoryConstrained(env: Pick<BackendEnv, 'ua' | 'maxTouchPoints' | 'deviceMemory' | 'mobile'>): boolean {
  if (isPhoneOrTablet(env)) return true;
  return typeof env.deviceMemory === 'number' && env.deviceMemory <= 4;
}

/**
 * Backends to try, in order. `preferred` (a test hook) goes first. WebGL leads only on desktops with a
 * hardware renderer; on memory-constrained devices it is kept as a fallback behind WASM (with the
 * memory-safe settings it needs ~200 MB, still better than the CPU backend's minutes per song).
 */
export function chooseBackendOrder(env: BackendEnv, preferred?: string): string[] {
  const order: string[] = [];
  if (preferred) order.push(preferred);
  const constrained = isMemoryConstrained(env);
  const hardwareGl = env.offscreen && !env.softwareRenderer;
  if (hardwareGl && !constrained) order.push('webgl');
  order.push('wasm');
  if (env.offscreen) order.push('webgl');
  order.push('cpu');
  return [...new Set(order)];
}

/**
 * TF.js WebGL flags applied before any WebGL kernel runs:
 * - WEBGL_CONV_IM2COL off: the im2col convolution is what needs ~170 MB per window; the direct
 *   convolution needs a fraction of that and was not slower (1.78 GB → 208 MB measured).
 * - WEBGL_DELETE_TEXTURE_THRESHOLD 0: free textures as soon as they are released instead of keeping
 *   every size ever used in the pool (the default, -1, never frees).
 */
export const WEBGL_MEMORY_FLAGS: Readonly<Record<string, number | boolean>> = {
  WEBGL_CONV_IM2COL: false,
  WEBGL_DELETE_TEXTURE_THRESHOLD: 0,
};

/**
 * Windows per model call. WebGL: 1. Measured with WebGL forced (headless Chromium, SwiftShader, a 30 s
 * file, 19 windows): before this change (im2col, no texture freeing, batch 4) the TF.js pool reached
 * 2.67 GB and the GPU process 2.9 GB; with the flags above the GPU process peaked at 258 MB with
 * batch 2 and 181 MB with batch 1, and batch 1 was also the fastest (22.8 s vs 31–39 s).
 * WASM: 2 (XNNPACK, no GPU memory). CPU: 1.
 */
export function batchFor(backend: string): number {
  if (backend === 'webgl') return WEBGL_BATCH;
  if (backend === 'wasm') return 2;
  return 1;
}

export const WEBGL_BATCH = 1;
