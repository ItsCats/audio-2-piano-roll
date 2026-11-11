/**
 * Live playback controller.
 *
 * Song time is derived from the AudioContext clock (never from requestAnimationFrame), so
 * visuals and audio stay locked even when frames are dropped. Notes are scheduled ~200 ms
 * ahead by a 25 ms timer (the "two clocks" pattern). Looping re-anchors the clock exactly at
 * the loop end, and the visual time is compensated by the device's output latency.
 */
import type { Hand, Note, PedalRange, TempoInfo } from '../music/types';
import { PianoEngine } from './pianoEngine';
import { buildEvents, firstEventIndexAtOrAfter, pedalDownAt, type PlayEvent } from './events';
import { scheduleClick } from './metronome';
import type { AudioSettings } from './types';

const LOOKAHEAD = 0.2;
const TICK_MS = 25;

interface Anchor {
  ctxTime: number;
  songTime: number;
  rate: number;
}

export interface PlayerOptions {
  metronome: boolean;
  metronomeVolume: number;
  countIn: boolean;
  hands: Record<Hand, boolean>;
  rate: number;
  loop: { start: number; end: number } | null;
}

type Listener = () => void;

export class PlaybackController {
  readonly ctx: AudioContext;
  readonly engine: PianoEngine;
  private master: GainNode;
  private clickBus: GainNode;
  private originalGain: GainNode;
  private originalEl: HTMLAudioElement | null = null;
  private originalSrc: MediaElementAudioSourceNode | null = null;
  private notes: Note[] = [];
  private pedal: PedalRange[] = [];
  private tempo: TempoInfo | null = null;
  private events: PlayEvent[] = [];
  private eventIdx = 0;
  private beatIdx = 0;
  private anchors: Anchor[] = [];
  private scheduledUntil = 0; // song time
  private timer: number | null = null;
  private playing = false;
  private pausedAt = 0;
  private duration = 0;
  private countInUntilCtx = 0;
  private listeners = new Set<Listener>();
  private holdAt: number | null = null; // wait-mode freeze point
  opts: PlayerOptions = {
    metronome: false,
    metronomeVolume: 0.7,
    countIn: false,
    hands: { L: true, R: true },
    rate: 1,
    loop: null,
  };

  constructor() {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.engine = new PianoEngine(this.ctx, this.master);
    this.clickBus = this.ctx.createGain();
    this.clickBus.connect(this.master);
    this.originalGain = this.ctx.createGain();
    this.originalGain.gain.value = 0;
    this.originalGain.connect(this.master);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setSong(notes: Note[], pedal: PedalRange[], tempo: TempoInfo, duration: number): void {
    this.notes = notes;
    this.pedal = pedal;
    this.tempo = tempo;
    this.duration = duration;
    this.rebuildEvents();
  }

  /** Replace notes (after edits / difficulty switch) without interrupting playback. */
  updateNotes(notes: Note[], pedal: PedalRange[]): void {
    this.notes = notes;
    this.pedal = pedal;
    this.rebuildEvents();
  }

  private rebuildEvents() {
    this.events = buildEvents(this.notes, this.pedal, this.opts.hands);
    this.eventIdx = firstEventIndexAtOrAfter(this.events, this.playing ? this.scheduledUntil : this.pausedAt);
  }

  setOptions(partial: Partial<PlayerOptions>): void {
    const prevHands = this.opts.hands;
    const prevRate = this.opts.rate;
    this.opts = { ...this.opts, ...partial };
    if (partial.hands && (partial.hands.L !== prevHands.L || partial.hands.R !== prevHands.R)) {
      this.rebuildEvents();
      if (this.playing) this.engine.allNotesOff(this.ctx.currentTime, false);
    }
    if (partial.rate !== undefined && partial.rate !== prevRate && this.playing) {
      // re-anchor at the current position with the new rate
      const now = this.getTime();
      this.engine.allNotesOff(this.ctx.currentTime, false);
      this.startFrom(now, false);
    }
    if (this.originalEl) this.originalEl.playbackRate = this.opts.rate;
    this.emit();
  }

  async applyAudioSettings(s: AudioSettings, onProgress?: (l: number, t: number) => void): Promise<void> {
    this.originalGain.gain.setTargetAtTime(s.originalVolume, this.ctx.currentTime, 0.05);
    await this.engine.applySettings(s, onProgress);
  }

  /** Attach the original recording for A/B comparison with the transcription. */
  setOriginalAudio(blob: Blob | null): void {
    if (this.originalEl) {
      this.originalEl.pause();
      URL.revokeObjectURL(this.originalEl.src);
      this.originalSrc?.disconnect();
      this.originalEl = null;
      this.originalSrc = null;
    }
    if (!blob) return;
    const el = new Audio();
    el.src = URL.createObjectURL(blob);
    el.preload = 'auto';
    (el as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = true;
    this.originalSrc = this.ctx.createMediaElementSource(el);
    this.originalSrc.connect(this.originalGain);
    this.originalEl = el;
  }

  get hasOriginalAudio(): boolean {
    return this.originalEl !== null;
  }

  /** Current song time in seconds (audio clock). */
  getTime(): number {
    if (!this.playing) return this.pausedAt;
    const now = this.ctx.currentTime;
    let a = this.anchors[0];
    for (const x of this.anchors) if (x.ctxTime <= now) a = x;
    const t = a.songTime + (now - a.ctxTime) * a.rate;
    if (this.holdAt !== null && t > this.holdAt) return this.holdAt;
    return t;
  }

  /** Song time of what the listener hears right now (compensates output latency). */
  getVisualTime(): number {
    if (!this.playing) return this.pausedAt;
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return this.getTime() - latency * this.opts.rate;
  }

  /** Seconds of count-in remaining (for the UI), 0 if none. */
  getCountInRemaining(): number {
    return this.playing ? Math.max(0, this.countInUntilCtx - this.ctx.currentTime) : 0;
  }

  getDuration(): number {
    return this.duration;
  }

  async play(): Promise<void> {
    if (this.playing) return;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (!this.engine.loaded) await this.engine.load();
    let from = this.pausedAt;
    if (from >= this.duration - 0.05) from = this.opts.loop?.start ?? 0;
    this.startFrom(from, this.opts.countIn);
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedAt = Math.max(0, this.getTime());
    this.stopScheduling();
    this.engine.allNotesOff(this.ctx.currentTime, false);
    this.originalEl?.pause();
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(this.duration, t));
    if (this.playing) {
      this.engine.allNotesOff(this.ctx.currentTime);
      this.startFrom(clamped, false);
    } else {
      this.pausedAt = clamped;
    }
    this.emit();
  }

  /** Wait mode: freeze the clock at `t` until released (practice). */
  hold(t: number | null): void {
    if (t === null && this.holdAt !== null && this.playing) {
      const resumeAt = this.holdAt;
      this.holdAt = null;
      this.startFrom(resumeAt, false);
      return;
    }
    this.holdAt = t;
  }
  get heldAt(): number | null {
    return this.holdAt;
  }

  private startFrom(songTime: number, countIn: boolean) {
    this.stopScheduling(false);
    const rate = this.opts.rate;
    const ctxNow = this.ctx.currentTime;
    let ctxStart = ctxNow + 0.06;
    this.countInUntilCtx = 0;
    if (countIn && this.tempo) {
      const beat = 60 / this.tempo.bpm / rate;
      const n = this.tempo.beatsPerBar;
      for (let i = 0; i < n; i++) scheduleClick(this.ctx, this.clickBus, ctxStart + i * beat, i === 0, this.opts.metronomeVolume);
      ctxStart += n * beat;
      this.countInUntilCtx = ctxStart;
    }
    this.anchors = [{ ctxTime: ctxStart, songTime, rate }];
    if (countIn) this.anchors.unshift({ ctxTime: ctxNow, songTime: songTime - (ctxStart - ctxNow) * rate, rate });
    this.playing = true;
    this.scheduledUntil = songTime;
    this.eventIdx = firstEventIndexAtOrAfter(this.events, songTime);
    // notes already sounding at the seek point: re-strike those that began just before it
    const recent = this.notes.filter(
      (n) => this.opts.hands[n.hand] && n.start < songTime && n.start > songTime - 0.06 && n.start + n.dur > songTime,
    );
    for (const n of recent) this.engine.noteOn(n.midi, n.vel, ctxStart, n.id);
    if (pedalDownAt(this.pedal, songTime)) this.engine.setPedal(true, ctxStart);
    this.beatIdx = this.tempo ? this.tempo.beats.findIndex((b) => b >= songTime) : -1;
    this.syncOriginal(songTime, ctxStart);
    this.tick();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private stopScheduling(setPlaying = true) {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (setPlaying) this.playing = false;
  }

  private songToCtx(t: number): number {
    const a = this.anchors[this.anchors.length - 1];
    return a.ctxTime + (t - a.songTime) / a.rate;
  }

  private syncOriginal(songTime: number, ctxStart: number) {
    const el = this.originalEl;
    if (!el) return;
    el.playbackRate = this.opts.rate;
    const delayMs = Math.max(0, (ctxStart - this.ctx.currentTime) * 1000);
    el.pause();
    window.setTimeout(() => {
      if (!this.playing) return;
      el.currentTime = Math.max(0, this.getTime());
      void el.play().catch(() => {});
    }, delayMs);
  }

  private tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const horizonCtx = now + LOOKAHEAD;
    const a = this.anchors[this.anchors.length - 1];
    let horizon = a.songTime + (horizonCtx - a.ctxTime) * a.rate;
    if (this.holdAt !== null) horizon = Math.min(horizon, this.holdAt);
    const loop = this.opts.loop;

    if (loop && loop.end > loop.start + 0.2 && horizon >= loop.end && this.scheduledUntil < loop.end) {
      this.scheduleRange(this.scheduledUntil, loop.end);
      const loopCtx = this.songToCtx(loop.end);
      this.engine.allNotesOff(loopCtx, false);
      const past = this.anchors.filter((x) => x.ctxTime <= now);
      const future = this.anchors.filter((x) => x.ctxTime > now);
      this.anchors = [...past.slice(-1), ...future, { ctxTime: loopCtx, songTime: loop.start, rate: a.rate }];
      this.scheduledUntil = loop.start;
      this.eventIdx = firstEventIndexAtOrAfter(this.events, loop.start);
      this.beatIdx = this.tempo ? this.tempo.beats.findIndex((b) => b >= loop.start) : -1;
      if (pedalDownAt(this.pedal, loop.start)) this.engine.setPedal(true, loopCtx);
      if (this.originalEl) window.setTimeout(() => this.originalEl && (this.originalEl.currentTime = loop.start), Math.max(0, (loopCtx - now) * 1000));
      horizon = loop.start + (horizonCtx - loopCtx) * a.rate;
    }
    if (horizon > this.scheduledUntil) {
      this.scheduleRange(this.scheduledUntil, horizon);
      this.scheduledUntil = horizon;
    }
    // end of song
    const t = this.getTime();
    if (!loop && t >= this.duration + 0.5) {
      this.pausedAt = this.duration;
      this.stopScheduling();
      this.engine.allNotesOff(now, false);
      this.originalEl?.pause();
      this.emit();
      return;
    }
    // keep the original recording in sync (media elements drift)
    const el = this.originalEl;
    if (el && !el.paused && this.countInUntilCtx <= now) {
      const drift = el.currentTime - t;
      if (Math.abs(drift) > 0.08) el.currentTime = t;
    }
  }

  private scheduleRange(from: number, to: number) {
    const ev = this.events;
    while (this.eventIdx < ev.length && ev[this.eventIdx].t < to) {
      const e = ev[this.eventIdx++];
      if (e.t < from - 1e-6) continue;
      const when = this.songToCtx(e.t);
      if (e.kind === 'on') this.engine.noteOn(e.midi, e.vel, when, e.tag);
      else if (e.kind === 'off') this.engine.noteOff(e.midi, when, e.tag);
      else this.engine.setPedal(e.down, when);
    }
    if (this.opts.metronome && this.tempo && this.beatIdx >= 0) {
      const beats = this.tempo.beats;
      while (this.beatIdx < beats.length && beats[this.beatIdx] < to) {
        const b = beats[this.beatIdx];
        if (b >= from) {
          const accent = (this.beatIdx - this.tempo.downbeatIndex) % this.tempo.beatsPerBar === 0;
          scheduleClick(this.ctx, this.clickBus, this.songToCtx(b), accent, this.opts.metronomeVolume);
        }
        this.beatIdx++;
      }
    }
  }

  /** Play a note immediately (MIDI keyboard / clicking the on-screen piano). */
  liveNoteOn(midi: number, vel: number): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
    this.engine.noteOn(midi, vel, this.ctx.currentTime);
  }
  liveNoteOff(midi: number): void {
    this.engine.noteOff(midi, this.ctx.currentTime);
  }
  livePedal(down: boolean): void {
    this.engine.setPedal(down, this.ctx.currentTime);
  }

  dispose(): void {
    this.stopScheduling();
    this.setOriginalAudio(null);
    this.engine.dispose();
    void this.ctx.close();
  }
}
