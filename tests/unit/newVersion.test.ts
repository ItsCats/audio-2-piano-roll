import { describe, expect, it } from 'vitest';
import { entryScript, isChunkLoadError } from '../../src/lib/newVersion';

describe('new version after a deploy', () => {
  it('finds the entry script of a built page', () => {
    const html = '<head><script type="module" crossorigin src="/assets/index-AbC123.js"></script><link rel="modulepreload" href="/assets/x.js"></head>';
    expect(entryScript(html)).toBe('/assets/index-AbC123.js');
    expect(entryScript('<script src="/assets/index-Z.js" type="module"></script>')).toBe('/assets/index-Z.js');
    // the development page has no built entry
    expect(entryScript('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
  });

  it('recognises chunk-load failures of Chrome, Firefox and Safari', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Studio-1.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: https://x/assets/Studio-1.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/Studio-1.css'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});
