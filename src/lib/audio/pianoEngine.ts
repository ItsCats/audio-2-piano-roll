/**
 * Sampled piano voice engine built directly on the Web Audio API so it can run both on a
 * live AudioContext and inside an OfflineAudioContext (WAV / video export).
 *
 * Events must be fed in chronological order (the scheduler guarantees this); the engine
 * keeps a small state machine of key-down / sustained-by-pedal voices like a real piano:
 *  - releasing a key with the pedal up starts the damper decay,
 *  - releasing a key with the pedal down keeps the string ringing until the pedal lifts,
 *  - re-striking a ringing note damps the previous vibration,
 *  - the top ~1.5 octaves have no dampers (as on acoustic pianos) and ring on.
 */
import { SampleLibrary } from './sampleLibrary';
import { getPreset, type PianoPreset } from './presets';
import { Chorus, impulseResponse } from './effects';
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from './types';

interface Voice {
  midi: number;
  tag: number;
  src: AudioBufferSourceNode;
  gain: GainNode;
  start: number;
  keyDown: boolean;
  released: boolean;
}

const MAX_VOICES = 96;
const UNDAMPED_FROM = 90; // F#6 and above have no dampers

const dbToGain = (db: number) => Math.pow(10, db / 20);

export class PianoEngine {
  /**
   * Processing latency of the output chain: each DynamicsCompressorNode delays its signal by
   * a fixed 6 ms look-ahead (Blink/WebKit/Gecko share the implementation), and we use two.
   * Live visuals, the metronome and offline renders compensate for this.
   */
  static readonly LATENCY = 0.012;
  readonly ctx: BaseAudioContext;
  readonly output: GainNode;
  private library: SampleLibrary | null = null;
  private preset: PianoPreset;
  private settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private voices: Voice[] = [];
  private pedalDown = false;
  private voiceBus: GainNode;
  private lowShelf: BiquadFilterNode;
  private highShelf: BiquadFilterNode;
  private presence: BiquadFilterNode;
  private reverb: ConvolverNode;
  private reverbSend: GainNode;
  private chorus: Chorus;
  private compressor: DynamicsCompressorNode;
  private limiter: DynamicsCompressorNode;
  private noiseBus: GainNode;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.preset = getPreset(this.settings.presetId);
    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 0.42;
    this.noiseBus = ctx.createGain();
    this.lowShelf = ctx.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 180;
    this.highShelf = ctx.createBiquadFilter();
    this.highShelf.type = 'highshelf';
    this.highShelf.frequency.value = 4500;
    this.presence = ctx.createBiquadFilter();
    this.presence.type = 'peaking';
    this.presence.frequency.value = 2600;
    this.presence.Q.value = 0.8;
    this.chorus = new Chorus(ctx);
    this.reverb = ctx.createConvolver();
    this.reverbSend = ctx.createGain();
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -16;
    this.compressor.ratio.value = 2.2;
    this.compressor.knee.value = 10;
    this.compressor.attack.value = 0.01;
    this.compressor.release.value = 0.25;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.output = ctx.createGain();

    this.voiceBus.connect(this.lowShelf);
    this.noiseBus.connect(this.lowShelf);
    this.lowShelf.connect(this.highShelf).connect(this.presence).connect(this.chorus.input);
    this.chorus.output.connect(this.compressor);
    this.chorus.output.connect(this.reverbSend).connect(this.reverb).connect(this.compressor);
    this.compressor.connect(this.limiter).connect(this.output).connect(destination);
    this.applyParams();
  }

  get loaded(): boolean {
    return this.library !== null;
  }

  async load(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    this.library = await SampleLibrary.load(this.preset.library, onProgress);
  }

  /** Apply user audio settings. Resolves once the preset's sample set is loaded. */
  async applySettings(s: AudioSettings, onProgress?: (l: number, t: number) => void): Promise<void> {
    this.settings = { ...s };
    this.preset = getPreset(s.presetId);
    this.applyParams();
    if (!this.library || this.library.def.id !== this.preset.library) {
      this.library = await SampleLibrary.load(this.preset.library, onProgress);
    }
  }

  private applyParams(): void {
    const s = this.settings;
    const t = this.ctx.currentTime;
    const p = this.preset;
    this.lowShelf.gain.setValueAtTime(p.eq.lowShelfDb - s.brightness * 1.5, t);
    this.highShelf.gain.setValueAtTime(p.eq.highShelfDb + s.brightness * 5, t);
    this.presence.gain.setValueAtTime(p.eq.presenceDb + s.brightness * 1.5, t);
    this.output.gain.setValueAtTime(s.volume * dbToGain(p.gainDb), t);
    this.chorus.set(s.chorus, t);
    if (s.reverbType === 'off' || s.reverbMix <= 0) {
      this.reverbSend.gain.setValueAtTime(0, t);
    } else {
      this.reverb.buffer = impulseResponse(this.ctx, s.reverbType);
      this.reverbSend.gain.setValueAtTime(s.reverbMix * 0.9, t);
    }
    this.noiseBus.gain.setValueAtTime(s.mechanicalNoise ? 1 : 0, t);
  }

  getSettings(): AudioSettings {
    return this.settings;
  }

  /**
   * Start a note. `velocity` is 0..1. `tag` identifies the note so its note-off releases
   * exactly this voice even when same-pitch notes overlap.
   */
  noteOn(midi: number, velocity: number, time: number, tag = -1): void {
    const lib = this.library;
    if (!lib) return;
    const t = Math.max(time, this.ctx.currentTime);
    const sens = this.settings.velocitySensitivity;
    const v = Math.max(0.02, Math.min(1, 0.62 * (1 - sens) + velocity * sens));
    const shaped = Math.pow(v, this.preset.velocityCurve);
    const v127 = Math.max(1, Math.min(127, shaped * 127 + this.preset.layerBias * 40));
    const pick = lib.pick(midi, v127);
    if (!pick) return;

    // damp a still-ringing voice of the same key (hammer re-strike)
    for (const voice of this.voices) {
      if (voice.midi === midi && !voice.released) this.releaseVoice(voice, t, 0.035);
    }
    this.enforcePolyphony(t);

    const src = this.ctx.createBufferSource();
    src.buffer = pick.sample.buffer;
    src.playbackRate.value = Math.pow(2, (midi - pick.root) / 12);
    const gain = this.ctx.createGain();
    // within-layer level adjustment, then a gentle overall dynamic curve
    const layerRatio = Math.pow(v127 / pick.layerVel, 1.1);
    const level = Math.min(1.8, Math.max(0.35, layerRatio)) * (0.55 + 0.45 * shaped);
    gain.gain.setValueAtTime(level, t);
    let node: AudioNode = src;
    if (this.preset.velocityFilter) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      const { minHz, maxHz } = this.preset.velocityFilter;
      const keyTrack = Math.pow(2, (midi - 60) / 24);
      f.frequency.value = Math.min(18000, (minHz + (maxHz - minHz) * shaped * shaped) * keyTrack);
      f.Q.value = 0.5;
      node.connect(f);
      node = f;
    }
    node.connect(gain).connect(this.voiceBus);
    src.start(t, pick.sample.offset);
    const voice: Voice = { midi, tag, src, gain, start: t, keyDown: true, released: false };
    src.onended = () => {
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
      gain.disconnect();
    };
    this.voices.push(voice);
  }

  noteOff(midi: number, time: number, tag = -1, releaseVelocity = 0.5): void {
    const t = Math.max(time, this.ctx.currentTime);
    // release this note's voice (or, untagged, the oldest held voice for this key)
    const voice =
      tag >= 0
        ? this.voices.find((v) => v.tag === tag && v.keyDown)
        : this.voices.find((v) => v.midi === midi && v.keyDown && !v.released);
    if (!voice) return;
    voice.keyDown = false;
    if (this.pedalDown && this.settings.pedalEnabled) return; // sustained by the pedal
    this.damp(voice, t, releaseVelocity);
  }

  setPedal(down: boolean, time: number): void {
    if (!this.settings.pedalEnabled) {
      this.pedalDown = false;
      return;
    }
    if (down === this.pedalDown) return;
    const t = Math.max(time, this.ctx.currentTime);
    this.pedalDown = down;
    this.playNoise(this.library?.pedalNoise(down), t, 0.5, this.library?.def.pedalGainDb ?? -22);
    if (!down) {
      for (const v of this.voices) if (!v.keyDown && !v.released) this.damp(v, t, 0.3, false);
    }
  }

  get isPedalDown(): boolean {
    return this.pedalDown;
  }

  private damp(voice: Voice, t: number, releaseVelocity: number, keyNoise = true) {
    const undamped = voice.midi >= UNDAMPED_FROM;
    // bass strings take longer to settle under the felt
    const tau = undamped ? 1.2 : this.preset.damperTime * (voice.midi < 40 ? 1.6 : voice.midi < 55 ? 1.25 : 1);
    this.releaseVoice(voice, t, tau);
    if (keyNoise && !undamped) {
      this.playNoise(this.library?.release(voice.midi), t, 0.4 + releaseVelocity * 0.6, this.library?.def.releaseGainDb ?? -30);
    }
  }

  private releaseVoice(voice: Voice, t: number, tau: number) {
    if (voice.released) return;
    voice.released = true;
    voice.keyDown = false;
    const g = voice.gain.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0, t, tau);
    try {
      voice.src.stop(t + tau * 7 + 0.05);
    } catch {
      /* already stopped */
    }
  }

  private playNoise(sample: { buffer: AudioBuffer; offset: number } | undefined, t: number, level: number, gainDb: number) {
    if (!sample || !this.settings.mechanicalNoise) return;
    const src = this.ctx.createBufferSource();
    src.buffer = sample.buffer;
    const g = this.ctx.createGain();
    g.gain.value = dbToGain(gainDb) * level * 4;
    src.connect(g).connect(this.noiseBus);
    src.onended = () => g.disconnect();
    src.start(t, sample.offset);
  }

  private enforcePolyphony(t: number) {
    const active = this.voices.filter((v) => !v.released);
    if (active.length < MAX_VOICES) return;
    // steal the oldest non-held voices first
    const victims = active.sort((a, b) => Number(a.keyDown) - Number(b.keyDown) || a.start - b.start);
    for (let i = 0; i <= active.length - MAX_VOICES; i++) this.releaseVoice(victims[i], t, 0.02);
  }

  /** Silence everything quickly (seek / stop). */
  allNotesOff(time = this.ctx.currentTime, fast = true): void {
    for (const v of this.voices) this.releaseVoice(v, time, fast ? 0.015 : 0.2);
    this.pedalDown = false;
  }

  get activeVoices(): number {
    return this.voices.filter((v) => !v.released).length;
  }

  dispose(): void {
    this.allNotesOff();
    this.output.disconnect();
  }
}
