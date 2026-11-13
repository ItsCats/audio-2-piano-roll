/**
 * iPhone / iPad: with the ring/silent switch on, Safari mutes web audio unless the page says it
 * plays music (the Audio Session API, Safari 16.4+). The piano should sound like any music app,
 * so the first tap that starts sound sets the session type to 'playback'; while recording from the
 * microphone it is 'play-and-record', then back. Feature-detected: does nothing elsewhere.
 * https://developer.mozilla.org/docs/Web/API/AudioSession/type
 */
type SessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';
interface AudioSessionLike {
  type: SessionType;
}

function session(): AudioSessionLike | null {
  const nav = (globalThis as { navigator?: { audioSession?: unknown } }).navigator;
  const s = nav?.audioSession;
  return s && typeof s === 'object' && 'type' in s ? (s as AudioSessionLike) : null;
}

function setType(type: SessionType): void {
  const s = session();
  if (!s || s.type === type) return;
  try {
    s.type = type;
  } catch {
    /* not allowed right now: keep the browser's default */
  }
}

let recordings = 0;

/** Call from the user gesture that starts sound (Play, a key on the on-screen piano...). */
export function audioSessionForPlayback(): void {
  if (recordings === 0) setType('playback');
}

/**
 * Call when recording from the microphone starts; the returned function (safe to call more than
 * once) switches back to playback when it stops.
 */
export function audioSessionForRecording(): () => void {
  recordings++;
  setType('play-and-record');
  let done = false;
  return () => {
    if (done) return;
    done = true;
    recordings = Math.max(0, recordings - 1);
    if (recordings === 0) setType('playback');
  };
}

/**
 * The import mini-games' sound effects (lib/games/synth): 'ambient', so on an iPhone the silent switch
 * mutes them and music the player has on in another app keeps playing (unlike the piano, which plays
 * like a music app). Call from the gesture that starts the games' sound; the returned function puts
 * back what was there (safe to call more than once). Does nothing while recording.
 */
export function audioSessionForEffects(): () => void {
  const s = session();
  if (!s || recordings > 0) return () => undefined;
  const before = s.type;
  setType('ambient');
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (recordings === 0 && s.type === 'ambient' && before !== 'ambient') setType(before);
  };
}
