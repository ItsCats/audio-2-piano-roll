import { describe, expect, it } from 'vitest';
import { tabAudioSupport } from '../../src/lib/audio/tabAudio';
import { COMPUTER_SOUND_IMPORT, isLegacyYouTubeImport, routeIsIsolated } from '../../src/lib/isolation';

type FakeNav = { userAgent: string; maxTouchPoints?: number; userAgentData?: { brands: { brand: string }[]; mobile: boolean }; mediaDevices?: { getDisplayMedia?: () => void } };
const nav = (n: FakeNav) => n as unknown as Navigator;
const display = { getDisplayMedia: () => undefined };
const chrome = { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }], mobile: false };

describe('"Computer sound" tab: which browsers can record another tab', () => {
  // MediaRecorder exists in browsers; vitest runs in Node
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder ??= class {};

  it('desktop Chrome and Edge can', () => {
    expect(tabAudioSupport(nav({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/142.0', userAgentData: chrome, mediaDevices: display }))).toBe('ok');
    const edge = { brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }], mobile: false };
    expect(tabAudioSupport(nav({ userAgent: 'Mozilla/5.0 (Macintosh) Edg/142.0', userAgentData: edge, mediaDevices: display }))).toBe('ok');
  });

  it('iPhone and iPad (also iPadOS posing as a Mac) get the screen-recording advice', () => {
    expect(tabAudioSupport(nav({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }))).toBe('iphone');
    expect(tabAudioSupport(nav({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/142.0 Mobile', mediaDevices: display }))).toBe('iphone');
    expect(tabAudioSupport(nav({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15', maxTouchPoints: 5, mediaDevices: display }))).toBe('iphone');
  });

  it('Android phones get the phone advice', () => {
    expect(tabAudioSupport(nav({ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/142.0 Mobile', userAgentData: { ...chrome, mobile: true }, mediaDevices: display }))).toBe('phone');
  });

  it('desktop Safari and Firefox share no tab sound: "use Chrome or Edge"', () => {
    expect(tabAudioSupport(nav({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15', maxTouchPoints: 0, mediaDevices: display }))).toBe('browser');
    expect(tabAudioSupport(nav({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', mediaDevices: display }))).toBe('browser');
    expect(tabAudioSupport(nav({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/142.0', userAgentData: chrome }))).toBe('browser'); // no getDisplayMedia (e.g. not https)
    expect(tabAudioSupport(undefined)).toBe('browser');
  });
});

describe('old links to the removed YouTube tab', () => {
  it('are recognised and lead to the isolated "Computer sound" tab', () => {
    expect(isLegacyYouTubeImport('/import/youtube')).toBe(true);
    expect(isLegacyYouTubeImport('/import/youtube/', '?url=x')).toBe(true);
    expect(isLegacyYouTubeImport('/import', '?tab=youtube&url=x')).toBe(true);
    expect(isLegacyYouTubeImport('/import', '?tab=audio')).toBe(false);
    expect(isLegacyYouTubeImport('/studio/youtube')).toBe(false);
    expect(COMPUTER_SOUND_IMPORT).toBe('/import?tab=computer');
    expect(routeIsIsolated('/import')).toBe(true);
  });

  it('the Privacy, Terms and Copyright pages are isolated like the other app pages (no reload when moving on)', () => {
    for (const r of ['/privacy', '/terms', '/copyright', '/privacy/']) expect(routeIsIsolated(r)).toBe(true);
    expect(routeIsIsolated('/import/youtube')).toBe(false);
    expect(routeIsIsolated('/no-such-page')).toBe(false);
  });
});
