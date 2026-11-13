/**
 * Times the homr reader (src/lib/omr/homr) in Playwright Chromium on raw page images (the OMR test set
 * converted with tests/homr/to_raw.py; kept outside the repository) and writes the MusicXML of each
 * page, for the scores and the comparison with Python homr (tests/homr/score_out.sh, compare.py).
 *
 *   node tests/e2e/homr-bench.mjs --raw DIR --out DIR [--cats clean,photo] [--only gen00] [--threads 3] [--no-coi]
 */
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const raw = path.resolve(opt('raw', ''));
const out = path.resolve(opt('out', 'homr-bench-out'));
const cats = opt('cats', 'clean,clean_real,photo,photo_real').split(',');
const only = opt('only', '').split(',').filter(Boolean);
const threads = +opt('threads', '3');
const port = +opt('port', '5184');
const coi = !args.includes('--no-coi');
const { chromium } = await import('playwright');
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true, fs: { allow: [root, raw] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${port}/tests/e2e/homr.html${coi ? '?coi=1' : ''}`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
  console.log(`crossOriginIsolated=${await page.evaluate(() => self.crossOriginIsolated)} threads ${threads}`);
  for (const cat of cats) {
    fs.mkdirSync(path.join(out, cat), { recursive: true });
    for (const f of fs.readdirSync(path.join(raw, cat)).filter((x) => x.endsWith('.json')).sort()) {
      const name = f.replace(/\.json$/, '');
      if (only.length && !only.some((o) => name.startsWith(o))) continue;
      const { w, h } = JSON.parse(fs.readFileSync(path.join(raw, cat, f), 'utf8'));
      const url = `/@fs${path.join(raw, cat, `${name}.rgb`)}`;
      try {
        const r = await page.evaluate(([u, ww, hh, t]) => window.readRaw(u, ww, hh, t), [url, w, h, threads]);
        fs.writeFileSync(path.join(out, cat, `${name}.musicxml`), r.musicXml);
        const s = r.stats;
        console.log(`${cat}/${name} ${r.seconds}s staves ${r.staves} lines ${r.lines} seg ${(s.segmentMs / 1000).toFixed(1)}s enc ${(s.encodeMs / 1000).toFixed(1)}s dec ${(s.decodeMs / 1000).toFixed(1)}s steps ${s.steps} threads ${s.threads}`);
      } catch (e) {
        console.log(`${cat}/${name} ERROR ${e.message.split('\n')[0]}`);
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
