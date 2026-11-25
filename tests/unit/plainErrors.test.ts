import { describe, expect, it } from 'vitest';
import { plainDecodeError, UNREADABLE_FILE } from '../../src/lib/transcription/decode';

describe('a file the browser cannot decode', () => {
  it('gets a plain message instead of the decoder’s words', () => {
    expect(plainDecodeError('Could not decode this file. Input has an unsupported or unrecognizable format.')).toBe(UNREADABLE_FILE);
    expect(UNREADABLE_FILE).toBe('This file couldn’t be read. Try an MP3, WAV or M4A file.');
  });

  it('leaves other errors alone', () => {
    expect(plainDecodeError('File is empty.')).toBeNull();
    expect(plainDecodeError('This recording is 25 minutes long. The limit is 20 minutes. Trim it first.')).toBeNull();
  });
});
