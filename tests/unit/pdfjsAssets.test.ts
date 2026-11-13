/**
 * public/pdfjs/wasm/ holds hand copies of pdfjs-dist's WebAssembly image decoders and their licence
 * files (served from our own origin for scanned PDFs). This keeps them byte-identical to the installed
 * pdfjs-dist, so an upgrade of the package cannot leave stale decoders or licences behind.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const req = createRequire(import.meta.url);
const pkgDir = join(req.resolve('pdfjs-dist/package.json'), '..');
const ours = join(__dirname, '../../public/pdfjs/wasm');

describe('pdf.js decoders served from public/pdfjs/wasm', () => {
  it('match the installed pdfjs-dist byte for byte (copy them again after an upgrade)', () => {
    const files = readdirSync(ours).sort();
    expect(files).toContain('jbig2.wasm');
    expect(files).toContain('openjpeg.wasm');
    for (const f of files) expect(readFileSync(join(ours, f)).equals(readFileSync(join(pkgDir, 'wasm', f))), f).toBe(true);
    // every decoder pdf.js may ask for is there (quickjs-eval is PDF scripting, which we never run)
    const theirs = readdirSync(join(pkgDir, 'wasm')).filter((f) => f.endsWith('.wasm') && !f.startsWith('quickjs'));
    for (const f of theirs) expect(files, f).toContain(f);
  });
  it('the installed pdfjs-dist is the pinned version', () => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string };
    const app = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(app.dependencies['pdfjs-dist']).toBe(pkg.version);
  });
});
