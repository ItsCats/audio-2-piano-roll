/**
 * Which TensorFlow.js backend the transcription worker tries first.
 *
 * WebGL is fastest on a desktop GPU, but on phones it is a memory hazard: Basic Pitch's first
 * convolution runs through an im2col matrix of about 170 MB per 2-second window, and the texture
 * pool reached 1.8–2.7 GB in tests whatever the recording length. iOS Safari kills a tab that
 * uses that much and silently reloads the page, so analysis "resets like nothing happened".
 * Phones and low-memory devices therefore use WebAssembly (about 370 MB in total, still fast).
 */
export interface BackendEnv {
  /** navigator.userAgent */
  ua: string;
  /** navigator.maxTouchPoints (0 when unknown) */
  maxTouchPoints?: number;
  /** navigator.deviceMemory in GB (undefined in Safari and Firefox) */
  deviceMemory?: number;
  /** WebGL reports a software renderer (SwiftShader, llvmpipe …) */
  softwareRenderer: boolean;
  /** OffscreenCanvas exists in the worker (needed for WebGL there) */
  offscreen: boolean;
}

/** iPhone, iPod, or iPad (iPadOS presents a Mac user agent but has touch). */
export function isAppleMobile(ua: string, maxTouchPoints = 0): boolean {
  return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/** Phones, tablets and low-memory devices, where WebGL's memory use can crash the tab. */
export function isMemoryConstrained(env: Pick<BackendEnv, 'ua' | 'maxTouchPoints' | 'deviceMemory'>): boolean {
  if (isAppleMobile(env.ua, env.maxTouchPoints)) return true;
  if (/Android|Mobile|Silk|Kindle|Opera Mini|IEMobile/i.test(env.ua)) return true;
  if (typeof env.deviceMemory === 'number' && env.deviceMemory <= 4) return true;
  return false;
}

/** Backends to try, in order. An explicit preference is honoured first. */
export function chooseBackendOrder(env: BackendEnv, preferred?: string): string[] {
  const order: string[] = [];
  if (preferred) order.push(preferred);
  const gpuOk = env.offscreen && !env.softwareRenderer;
  if (gpuOk && !isMemoryConstrained(env)) order.push('webgl');
  order.push('wasm');
  if (env.offscreen && !isMemoryConstrained(env)) order.push('webgl');
  order.push('cpu');
  return [...new Set(order)];
}

/** Windows per inference batch: WebGL memory grows with the batch, so keep it small. */
export function batchFor(backend: string): number {
  return backend === 'webgl' ? 2 : backend === 'wasm' ? 2 : 1;
}
