/**
 * The separation checkbox's words per detection preset: "Remove singing and drums" under Piano solo
 * (with its limits line; it works with the high-accuracy piano model), "Separate vocals & drums"
 * everywhere else, exactly as before. (The rendered option is checked in tests/e2e/piano-part.mjs.)
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/pianoSpecialist', () => ({
  pianoSpecialistSupport: () => ({ available: true, recommended: true, downloadMB: 41, estSecondsPerMinute: 38 }),
}));
const { separationOptionText, PIANO_PART_LIMITS } = await import('../../src/components/import/SeparationOption');

const desktop = { engine: 'browser' as const, est: 54, maxSeconds: 600 };

describe('separation option text', () => {
  it('Piano solo: "Remove singing and drums", what it does, its time and memory, and what it cannot do', () => {
    const t = separationOptionText({ piano: true, ...desktop });
    expect(t.label).toBe('Remove singing and drums');
    expect(t.explain).toBe(
      'Separates the song first and turns only the rest into notes, so the singing isn’t played on the piano. Downloads a 13 MB model once and takes about 1× the song’s length. ' +
        'Memory grows with length (about 2.4 GB for a 4-minute song), so recordings over 10 minutes are transcribed without it.',
    );
    expect(t.limits).toBe(PIANO_PART_LIMITS);
    expect(PIANO_PART_LIMITS).toBe('Guitars, synths and other instruments stay in: the separation can’t tell them apart from the piano.');
    expect(t.warning).toBeUndefined();
    // with the piano model: both run, one after the other (the times add up)
    expect(separationOptionText({ piano: true, ...desktop, modelEst: 38 }).explain).toContain('takes about 2× the song’s length');
    // on the server
    expect(separationOptionText({ piano: true, ...desktop, engine: 'server' }).explain).toBe(
      'Separates the song on your processing server and turns only the rest into notes, so the singing isn’t played on the piano.',
    );
  });

  it('a phone: the memory warning, and with the piano model that it runs after the separation', () => {
    const reason = 'Needs about 2.4 GB of memory for a 4-minute song (more for longer ones) and several minutes per song.';
    const phone = { piano: true, engine: 'browser' as const, est: 108, maxSeconds: 600, lowMemory: true, reason };
    expect(separationOptionText({ ...phone, modelEst: 70 }).warning).toBe(`May run out of memory on this device. ${reason} The piano model runs after it.`);
    expect(separationOptionText(phone).warning).toBe(`May run out of memory on this device. ${reason}`);
  });

  it('Full song and Sensitive: "Separate vocals & drums" as before, no limits line', () => {
    const t = separationOptionText({ piano: false, ...desktop, modelEst: 38 });
    expect(t.label).toBe('Separate vocals & drums');
    expect(t.explain).toBe(
      'Better melody and fewer false notes on songs with drums or singing; downloads a 13 MB model once and takes about 1× the song’s length. ' +
        'Memory grows with length (about 2.4 GB for a 4-minute song), so recordings over 10 minutes are transcribed without it',
    );
    expect(t.limits).toBeUndefined();
    expect(separationOptionText({ piano: false, ...desktop, engine: 'server' }).explain).toBe(
      'Better melody and fewer false notes on songs with drums or singing; runs on your processing server',
    );
    const low = separationOptionText({ piano: false, ...desktop, lowMemory: true, reason: 'X.', modelEst: 38 });
    expect(low.warning).toBe('May run out of memory on this device. X.');
  });
});
