/**
 * Connects keyboard input (Web MIDI, on-screen keys, computer keyboard) to the piano engine,
 * live key highlighting and, when practice mode is on, the scorer and wait mode.
 */
import { midiInput, type MidiInputEvent } from '../lib/midiInput/webmidi';
import { PracticeScorer } from '../lib/midiInput/practice';
import { getPlayer } from './playback';
import { flashKey, liveKeys } from './liveInput';
import { useTransport } from './transportStore';
import { useSettings } from './settingsStore';
import { currentArrangement, useStudio } from './studioStore';

let scorer: PracticeScorer | null = null;
let timer: number | null = null;
let unsub: (() => void) | null = null;

const USER_KEY_COLOR = '#c4b5fd';

function onInput(e: MidiInputEvent) {
  const player = getPlayer();
  if (e.type === 'noteon') {
    player.liveNoteOn(e.midi, e.velocity);
    liveKeys.set(e.midi, USER_KEY_COLOR);
    const tr = useTransport.getState();
    if (scorer && tr.practiceActive) {
      const res = scorer.press(e.midi, player.getTime(), tr.rate);
      flashKey(e.midi, res.result);
      useTransport.setState({ stats: scorer.stats() });
    }
  } else if (e.type === 'noteoff') {
    player.liveNoteOff(e.midi);
    liveKeys.delete(e.midi);
  } else {
    player.livePedal(e.down);
  }
}

export function attachInput(): () => void {
  if (!unsub) unsub = midiInput.subscribe(onInput);
  return () => {
    unsub?.();
    unsub = null;
    liveKeys.clear();
  };
}

export function startPractice(): void {
  const st = useStudio.getState();
  const arr = currentArrangement(st);
  if (!arr) return;
  const tr = useTransport.getState();
  const s = useSettings.getState().practice;
  const player = getPlayer();
  scorer = new PracticeScorer(arr.notes, tr.practiceHands, s.timingWindowMs);
  scorer.reset(player.getTime());
  // the hands being practised are not played by the computer
  useTransport.setState({
    practiceActive: true,
    stats: scorer.stats(),
    hands: { L: !tr.practiceHands.L, R: !tr.practiceHands.R },
  });
  if (timer) clearInterval(timer);
  timer = window.setInterval(tick, 30);
}

export function stopPractice(): void {
  if (timer) clearInterval(timer);
  timer = null;
  getPlayer().hold(null);
  useTransport.setState({ practiceActive: false, hands: { L: true, R: true } });
}

export function resetPracticeScore(): void {
  if (!scorer) return;
  scorer.reset(getPlayer().getTime());
  useTransport.setState({ stats: scorer.stats() });
}

function tick() {
  if (!scorer) return;
  const player = getPlayer();
  const tr = useTransport.getState();
  const wait = useSettings.getState().practice.waitMode;
  if (!player.isPlaying) return;
  const t = player.getTime();
  if (wait) {
    const pending = scorer.nextPending(t);
    if (pending && pending.time <= t + 0.01) {
      if (player.heldAt === null) player.hold(pending.time);
      return; // don't count misses while waiting
    }
    if (player.heldAt !== null) player.hold(null);
  }
  const missed = scorer.update(t, tr.rate);
  if (missed.length) useTransport.setState({ stats: scorer.stats() });
}
