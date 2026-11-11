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

  private static cache = new Map<
    string,
    { playable: Promise<SampleLibrary>; complete: Promise<SampleLibrary>; listeners: Set<(l: number, t: number) => void> }
  >();

  /**
   * Load a library in two stages so playback can start quickly:
   *  - "playable": one mid-velocity layer for every sampled pitch (≈30 files),
   *  - "complete": the remaining velocity layers plus release/pedal noises.
   * By default the promise resolves once playable; pass `{ complete: true }` to wait for
   * everything (offline renders/exports always do, so they never lose quality). Notes played
   * before the other layers arrive use the nearest loaded layer.
   */
  static load(
    id: string,
    onProgress?: (loaded: number, total: number) => void,
    opts: { complete?: boolean } = {},
  ): Promise<SampleLibrary> {
    let entry = SampleLibrary.cache.get(id);
    if (!entry) {
      const listeners = new Set<(l: number, t: number) => void>();
      let resolvePlayable!: (lib: SampleLibrary) => void;
      let rejectPlayable!: (err: unknown) => void;
      const playable = new Promise<SampleLibrary>((res, rej) => {
        resolvePlayable = res;
        rejectPlayable = rej;
      });
      const complete = (async () => {
        const manifest = await loadManifest();
        const def = manifest.libraries.find((l) => l.id === id);
        if (!def) throw new Error(`Unknown sample library "${id}"`);
        const lib = new SampleLibrary(def);
        await lib.loadAll(
          (loaded, total) => listeners.forEach((l) => l(loaded, total)),
          () => resolvePlayable(lib),
        );
        return lib;
      })();
      complete.catch((err) => {
        rejectPlayable(err);
        SampleLibrary.cache.delete(id);
      });
      playable.catch(() => {});
      entry = { playable, complete, listeners };
      SampleLibrary.cache.set(id, entry);
    }
    if (onProgress) entry.listeners.add(onProgress);
    return opts.complete ? entry.complete : entry.playable;
  }

  /** Index of the layer closest to a medium velocity: the one loaded first. */
  private static coreLayer(zone: { layers: LayerDef[] }): LayerDef {
    return zone.layers.reduce((a, b) => (Math.abs(b.vel - 72) < Math.abs(a.vel - 72) ? b : a));
  }

  private async loadAll(onProgress: (loaded: number, total: number) => void, onPlayable: () => void) {
    const core = this.def.zones.map((z) => SampleLibrary.coreLayer(z).file);
    const coreSet = new Set(core);
    const rest = [
      ...this.def.zones.flatMap((z) => z.layers.map((l) => l.file)).filter((f) => !coreSet.has(f)),
      ...this.def.release.map((r) => r.file),
      ...(this.def.pedal ? [this.def.pedal.down, this.def.pedal.up] : []),
    ];
    const total = core.length + rest.length;
    let loaded = 0;
    const run = async (files: string[]) => {
      const queue = [...files];
      const worker = async () => {
        while (queue.length) {
          const file = queue.shift()!;
          try {
            this.samples.set(file, await fetchDecode(file));
          } catch (err) {
            // the core layer is required; other layers fall back to their neighbours and
            // release/pedal noises are optional garnish
            if (coreSet.has(file)) throw err;
            console.warn(err);
          }
          loaded++;
          onProgress(loaded, total);
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
    };
    await run(core);
    onPlayable();
    await run(rest);
  }

  /** Pick the sample for a note: nearest sampled pitch, nearest velocity layer. */
  pick(midi: number, velocity127: number): { sample: LoadedSample; root: number; layerVel: number } | null {
    const zone = this.def.zones[this.zoneFor[Math.max(0, Math.min(127, midi))]];
    // nearest velocity layer that has finished loading (all of them once loading completes)
    let best: LayerDef | null = null;
    let bestSample: LoadedSample | undefined;
    for (const l of zone.layers) {
      const sample = this.samples.get(l.file);
      if (!sample) continue;
      if (!best || Math.abs(l.vel - velocity127) < Math.abs(best.vel - velocity127)) {
        best = l;
        bestSample = sample;
      }
    }
    if (!best || !bestSample) return null;
    return { sample: bestSample, root: zone.midi, layerVel: best.vel };
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
