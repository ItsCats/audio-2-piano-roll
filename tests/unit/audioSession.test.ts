import { afterEach, describe, expect, it } from 'vitest';
import { audioSessionForPlayback, audioSessionForRecording } from '../../src/lib/audio/audioSession';

const nav = globalThis.navigator as unknown as Record<string, unknown>;

function install(initial = 'auto') {
  const s = { type: initial };
  Object.defineProperty(nav, 'audioSession', { value: s, configurable: true });
  return s;
}

afterEach(() => {
  delete nav.audioSession;
});

describe('iPhone audio session', () => {
  it('plays as music (ignores the silent switch) once sound starts', () => {
    const s = install();
    audioSessionForPlayback();
    expect(s.type).toBe('playback');
  });

  it('uses play-and-record while recording, then back to playback', () => {
    const s = install();
    audioSessionForPlayback();
    const end = audioSessionForRecording();
    expect(s.type).toBe('play-and-record');
    // starting playback during the recording must not take the microphone away
    audioSessionForPlayback();
    expect(s.type).toBe('play-and-record');
    end();
    end(); // twice is harmless
    expect(s.type).toBe('playback');
  });

  it('does nothing in browsers without the Audio Session API', () => {
    expect(() => {
      audioSessionForPlayback();
      audioSessionForRecording()();
    }).not.toThrow();
  });

  it('a browser that refuses the change is left as it is', () => {
    const s = {};
    Object.defineProperty(s, 'type', { get: () => 'auto', set: () => { throw new Error('nope'); }, enumerable: true });
    Object.defineProperty(nav, 'audioSession', { value: s, configurable: true });
    expect(() => audioSessionForPlayback()).not.toThrow();
  });
});
