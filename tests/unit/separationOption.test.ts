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
      'Keeps only the piano part: the singing, drums and bass are removed, so they aren’t turned into notes. Downloads a 13 MB model once and takes about 1× the song’s length. ' +
        'Memory grows with length (about 2.4 GB for a 4-minute song), so recordings over 10 minutes are transcribed without it.',
    );
    expect(t.limits).toBe(PIANO_PART_LIMITS);
    expect(PIANO_PART_LIMITS).toBe('Guitars, synths and other instruments stay in: the separation can’t tell them apart from the piano.');
    expect(t.warning).toBeUndefined();
    // with the piano model: both run, one after the other (the times add up)
    expect(separationOptionText({ piano: true, ...desktop, modelEst: 38 }).explain).toContain('takes about 2× the song’s length');
    // on the server
    expect(separationOptionText({ piano: true, ...desktop, engine: 'server' }).explain).toBe(
      'Keeps only the piano part: the singing, drums and bass are removed, so they aren’t turned into notes. Runs on your processing server.',
    );
  });

  it('a phone: the memory warning, and with the piano model that it runs after the separation', () => {
    const reason = 'Needs about 2.4 GB of memory for a 4-minute song (more for longer ones) and several minutes per song.';
    const phone = { piano: true, engine: 'browser' as const, est: 108, maxSeconds: 600, lowMemory: true, reason };
    expect(separationOptionText({ ...phone, modelEst: 70 }).warning).toBe(`May run out of memory on this device. ${reason} The piano model runs after it.`);
    expect(separationOptionText(phone).warning).toBe(`May run out of memory on this device. ${reason}`);
    // the memory figure is said once (in the warning), and the desktop length limit is left out
    const t = separationOptionText({ ...phone, modelEst: 70 });
    expect(t.explain).toBe(
      'Keeps only the piano part: the singing, drums and bass are removed, so they aren’t turned into notes. Downloads a 13 MB model once and takes about 3× the song’s length.',
    );
    expect(`${t.explain} ${t.limits} ${t.warning}`.match(/2\.4 GB/g)).toHaveLength(1);
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

describe('"Analyze again" knows the song’s length', () => {
  it('the piano model’s phone warning says when this song is too long; the Import page keeps its wording', async () => {
    const { pianoModelWarning } = await import('../../src/components/import/PianoModelOption');
    const phone = { phone: true, warnAboveSeconds: 360 };
    expect(pianoModelWarning(phone, 8 * 60)).toBe('May be slow on phones. This song is 8 minutes long, so it might not work on this phone.');
    expect(pianoModelWarning({ phone: false, warnAboveSeconds: 360 }, 8 * 60)).toBe('May be slow on this device. This song is 8 minutes long, so it might not work here.');
    // short enough: says so; not known (the Import page): as before
    expect(pianoModelWarning(phone, 3 * 60)).toBe('May be slow on phones. This song is under 6 minutes, so it should fit in this phone’s memory.');
    expect(pianoModelWarning({ phone: false, warnAboveSeconds: 360 }, 22)).toBe('May be slow on this device. This song is under 6 minutes, so it should work here.');
    expect(pianoModelWarning(phone)).toBe('May be slow on phones. Songs over 6 minutes might not work on phones with little memory.');
    expect(pianoModelWarning({ phone: false })).toBe('May be slow on this device. Songs over 6 minutes might not work.');
  });

  it('a recording too long to separate here is not recommended, with the reason the option shows', async () => {
    const { separationSupport, longReason } = await import('../../src/lib/separation');
    const { separationAvailability } = await import('../../src/state/importStore');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', maxTouchPoints: 0 });
    vi.stubGlobal('Worker', class {});
    try {
      const short = separationSupport(120);
      const long = separationSupport(15 * 60);
      if (short.ok && short.recommended) {
        expect(long.recommended).toBe(false);
        expect(long.reason).toBe(longReason(15 * 60));
        const a = separationAvailability(false, long);
        expect(a.reason).toBe(longReason(15 * 60));
        const t = separationOptionText({ piano: true, engine: a.engine, est: long.estSecondsPerMinute, maxSeconds: long.maxSeconds, lowMemory: true, reason: a.reason });
        expect(t.warning).toBe(`May run out of memory on this device. ${longReason(15 * 60)}`);
      }
      // a phone: the memory said for this recording (a short one needs nearly as much)
      vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', maxTouchPoints: 5 });
      const phone = separationSupport(22);
      expect(phone.ok && !phone.recommended).toBe(true);
      expect(phone.reason).toMatch(/^Needs about [\d.]+ GB of memory even for a 22-second recording like this one, and takes a while on a phone\.$/);
      expect(separationSupport().reason ?? '').toMatch(/for a 4-minute song|^$/);
      expect(longReason(15 * 60)).toMatch(/^A 15-minute recording needs about [\d.]+ GB of memory to separate in this browser\.$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
