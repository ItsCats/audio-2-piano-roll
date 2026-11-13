/**
 * The games' sound: a tiny Web Audio synth (a triangle tone with a soft octave on top and a quick
 * piano-like decay), so a game never starts the piano sample download. Quiet by default. It does not
 * change the page's audio session, so on an iPhone the ring/silent switch mutes it like any other
 * page sound. The audio context is made on the first tap or key press (browsers need a gesture) and
 * closed when the game closes.
 */

type Ctx = AudioContext;

export interface GameSynth {
  /** call from a tap / key press: creates or resumes the audio context */
  unlock(): void;
  /** play a MIDI note (does nothing while muted or before unlock) */
  play(pitch: number, velocity?: number): void;
  /** a short low "thud" when a run ends */
  thud(): void;
  setMuted(muted: boolean): void;
  close(): void;
}

export const GAME_VOLUME = 0.16;

export const midiToHz = (pitch: number) => 440 * Math.pow(2, (pitch - 69) / 12);

export function createGameSynth(muted: boolean): GameSynth {
  let ctx: Ctx | null = null;
  let master: GainNode | null = null;
  let isMuted = muted;
  let closed = false;

  const ensure = (): Ctx | null => {
    if (closed || isMuted) return ctx;
    if (!ctx) {
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        ctx = new AC({ latencyHint: 'interactive' });
        master = ctx.createGain();
        master.gain.value = GAME_VOLUME;
        master.connect(ctx.destination);
      } catch {
        ctx = null;
      }
    }
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    return ctx;
  };

  const tone = (freq: number, type: OscillatorType, peak: number, attack: number, decay: number, at: number) => {
    const c = ctx!;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    osc.connect(g);
    g.connect(master!);
    osc.start(at);
    osc.stop(at + attack + decay + 0.02);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
  };

  return {
    unlock() {
      ensure();
    },
    play(pitch, velocity = 0.8) {
      if (isMuted || closed || !ctx || ctx.state !== 'running') return;
      const f = midiToHz(pitch);
      const at = ctx.currentTime + 0.005;
      tone(f, 'triangle', 0.9 * velocity, 0.006, 0.75, at);
      tone(f * 2, 'sine', 0.22 * velocity, 0.004, 0.35, at);
    },
    thud() {
      if (isMuted || closed || !ctx || ctx.state !== 'running') return;
      tone(midiToHz(40), 'sine', 0.7, 0.005, 0.3, ctx.currentTime + 0.005);
    },
    setMuted(m) {
      isMuted = m;
      if (!m) ensure();
    },
    close() {
      closed = true;
      const c = ctx;
      ctx = null;
      master = null;
      if (c) void c.close().catch(() => undefined);
    },
  };
}
