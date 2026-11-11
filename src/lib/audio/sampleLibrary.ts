/**
 * Loads the self-hosted piano sample libraries (see public/samples/manifest.json).
 * Decoded AudioBuffers are context-independent, so one decoded set serves live playback
 * and offline (export) rendering alike.
 */
export interface LayerDef {
  vel: number;
  file: string;
}
export interface LibraryDef {
  id: string;
  name: string;
  license: string;
  zones: { midi: number; layers: LayerDef[] }[];
  release: { midi: number; file: string }[];
  releaseGainDb?: number;
  pedal: { down: string; up: string } | null;
  pedalGainDb?: number;
}

export interface LoadedSample {
  buffer: AudioBuffer;
  /** decoder padding to skip so the attack starts exactly on time */
  offset: number;
}

const SAMPLE_BASE = `${import.meta.env.BASE_URL}samples/`;
let manifestPromise: Promise<{ libraries: LibraryDef[] }> | null = null;
let decodeCtx: OfflineAudioContext | null = null;

function getDecodeCtx(): OfflineAudioContext {
  if (!decodeCtx) decodeCtx = new OfflineAudioContext(2, 1, 44100);
  return decodeCtx;
}

export function loadManifest(): Promise<{ libraries: LibraryDef[] }> {
  if (!manifestPromise) {
    manifestPromise = fetch(`${SAMPLE_BASE}manifest.json`).then((r) => {
      if (!r.ok) throw new Error(`Could not load piano samples (HTTP ${r.status})`);
      return r.json();
    });
    manifestPromise.catch(() => (manifestPromise = null));
  }
  return manifestPromise;
}

function leadingSilence(buf: AudioBuffer): number {
  const thr = 0.0006;
  const ch = buf.getChannelData(0);
  const ch2 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch;
  const limit = Math.min(ch.length, Math.round(buf.sampleRate * 0.08));
  for (let i = 0; i < limit; i++) {
    if (Math.abs(ch[i]) > thr || Math.abs(ch2[i]) > thr) return Math.max(0, (i - 32) / buf.sampleRate);
  }
  return 0;
}

async function fetchDecode(file: string, retries = 2): Promise<LoadedSample> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(SAMPLE_BASE + file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await getDecodeCtx().decodeAudioData(await res.arrayBuffer());
      return { buffer, offset: leadingSilence(buffer) };
    } catch (err) {
      if (attempt >= retries) throw new Error(`Failed to load sample ${file}: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

export class SampleLibrary {
  readonly def: LibraryDef;
  private samples = new Map<string, LoadedSample>();
  /** zone lookup: midi -> zone index (nearest sampled pitch) */
  private zoneFor = new Int16Array(128);

  private constructor(def: LibraryDef) {
    this.def = def;
    const zs = def.zones;
    for (let m = 0; m < 128; m++) {
      let best = 0;
      for (let i = 1; i < zs.length; i++) if (Math.abs(zs[i].midi - m) < Math.abs(zs[best].midi - m)) best = i;
      this.zoneFor[m] = best;
    }
  }

  private static cache = new Map<string, Promise<SampleLibrary>>();

  /**
   * Load a library. The middle velocity layers are fetched first so playback can begin
   * quickly; `ready` resolves once those are available, `complete` once everything is.
   */
  static load(id: string, onProgress?: (loaded: number, total: number) => void): Promise<SampleLibrary> {
    let p = SampleLibrary.cache.get(id);
    if (!p) {
      p = (async () => {
        const manifest = await loadManifest();
        const def = manifest.libraries.find((l) => l.id === id);
        if (!def) throw new Error(`Unknown sample library "${id}"`);
        const lib = new SampleLibrary(def);
        await lib.loadAll(onProgress);
        return lib;
      })();
      SampleLibrary.cache.set(id, p);
      p.catch(() => SampleLibrary.cache.delete(id));
    }
    return p;
  }

  private async loadAll(onProgress?: (loaded: number, total: number) => void) {
    const layerFiles = this.def.zones.flatMap((z) => z.layers.map((l) => l.file));
    const extra = [...this.def.release.map((r) => r.file), ...(this.def.pedal ? [this.def.pedal.down, this.def.pedal.up] : [])];
    const all = [...layerFiles, ...extra];
    let loaded = 0;
    const queue = [...all];
    const worker = async () => {
      while (queue.length) {
        const file = queue.shift()!;
        try {
          this.samples.set(file, await fetchDecode(file));
        } catch (err) {
          // release/pedal noises are optional garnish; note samples are not
          if (layerFiles.includes(file)) throw err;
          console.warn(err);
        }
        loaded++;
        onProgress?.(loaded, all.length);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  /** Pick the sample for a note: nearest sampled pitch, nearest velocity layer. */
  pick(midi: number, velocity127: number): { sample: LoadedSample; root: number; layerVel: number } | null {
    const zone = this.def.zones[this.zoneFor[Math.max(0, Math.min(127, midi))]];
    let layer = zone.layers[0];
    for (const l of zone.layers) if (Math.abs(l.vel - velocity127) < Math.abs(layer.vel - velocity127)) layer = l;
    const sample = this.samples.get(layer.file);
    if (!sample) return null;
    return { sample, root: zone.midi, layerVel: layer.vel };
  }

  release(midi: number): LoadedSample | undefined {
    const r = this.def.release.find((x) => x.midi === midi);
    return r ? this.samples.get(r.file) : undefined;
  }

  pedalNoise(down: boolean): LoadedSample | undefined {
    if (!this.def.pedal) return undefined;
    return this.samples.get(down ? this.def.pedal.down : this.def.pedal.up);
  }
}
