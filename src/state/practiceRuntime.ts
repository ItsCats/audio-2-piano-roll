/**
 * Connects keyboard input (Web MIDI, on-screen keys, computer keyboard) to the piano engine,
 * live key highlighting and, when practice mode is on, the scorer and wait mode.
 */
import { midiInput, type MidiInputEvent } from '../lib/midiInput/webmidi';
import { PracticeScorer, TimeJumpDetector, followSongTime, sameScoredNotes } from '../lib/midiInput/practice';
import type { Arrangement } from '../lib/music/types';
import { getPlayer } from './playback';
import { flashKey, liveKeys } from './liveInput';
import { useTransport } from './transportStore';
import { useSettings } from './settingsStore';
import { currentArrangement, useStudio } from './studioStore';

let scorer: PracticeScorer | null = null;
let timer: number | null = null;
let unsub: (() => void) | null = null;
let unwatch: (() => void) | null = null;
const jumps = new TimeJumpDetector();
let lastTick = 0; // performance.now() of the previous tick
let scoredArr: Arrangement | null = null; // the notes the scorer was built from

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
    if (useTransport.getState().practiceActive) stopPractice();
  };
}

/**
 * (Re)builds the scorer from the open arrangement. `keepPasses`: an edit to the notes starts a
 * new pass but keeps the earlier passes; a new level or other hands start over.
 */
function buildScorer(keepPasses: boolean): void {
  const arr = currentArrangement(useStudio.getState());
  if (!arr) return;
  const tr = useTransport.getState();
  const s = useSettings.getState().practice;
  const t = getPlayer().getTime();
  // a change that leaves the notes alone (e.g. the automatic pedal) keeps the pass going
  if (keepPasses && scorer && scoredArr && sameScoredNotes(scoredArr.notes, arr.notes)) {
    scoredArr = arr;
    return;
  }
  scoredArr = arr;
  if (keepPasses && scorer) {
    scorer.newPass(t);
    scorer.replaceNotes(arr.notes, tr.practiceHands, t);
  } else {
    scorer = new PracticeScorer(arr.notes, tr.practiceHands, s.timingWindowMs);
    scorer.reset(t);
  }
  jumps.reset(t);
  useTransport.setState({ stats: scorer.stats() });
}

export function startPractice(): void {
  if (!currentArrangement(useStudio.getState())) return;
  const tr = useTransport.getState();
  buildScorer(false);
  // the hands being practised are not played by the computer
  useTransport.setState({
    practiceActive: true,
    hands: { L: !tr.practiceHands.L, R: !tr.practiceHands.R },
  });
  unwatch?.();
  const offStudio = useStudio.subscribe((st, prev) => {
    if (!useTransport.getState().practiceActive) return;
    if (st.song?.id !== prev.song?.id || st.difficulty !== prev.difficulty) buildScorer(false);
    else if (currentArrangement(st) !== scoredArr) buildScorer(true);
  });
  const offTransport = useTransport.subscribe((st, prev) => {
    if (!st.practiceActive || st.practiceHands === prev.practiceHands) return;
    if (st.practiceHands.L === prev.practiceHands.L && st.practiceHands.R === prev.practiceHands.R) return;
    buildScorer(false);
    useTransport.setState({ hands: { L: !st.practiceHands.L, R: !st.practiceHands.R } });
  });
  const offSettings = useSettings.subscribe((st, prev) => {
    if (scorer && st.practice.timingWindowMs !== prev.practice.timingWindowMs) scorer.windowSec = st.practice.timingWindowMs / 1000;
    if (!st.practice.waitMode && prev.practice.waitMode && getPlayer().heldAt !== null) getPlayer().hold(null);
  });
  unwatch = () => {
    offStudio();
    offTransport();
    offSettings();
  };
  lastTick = performance.now();
  if (timer) clearInterval(timer);
  timer = window.setInterval(tick, 30);
}

export function stopPractice(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unwatch?.();
  unwatch = null;
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
  const now = performance.now();
  const wallDt = (now - lastTick) / 1000;
  lastTick = now;
  // the count-in runs song time up to the start point: not a jump
  if (player.isPlaying && player.getCountInRemaining() > 0) return;
  const t = player.getTime();
  // loop wrap, seek back or back to start → a new pass; seek forward → skip the notes in between
  const jump = followSongTime(scorer, jumps, t, player.isPlaying && player.heldAt === null ? wallDt * tr.rate : 0, tr.loopEnabled ? tr.loop : null);
  if (jump) useTransport.setState({ stats: scorer.stats() });
  if (!player.isPlaying) return;
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
