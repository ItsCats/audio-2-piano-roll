/**
 * Title page renderer checks in Playwright Chromium with the real fonts (dev server).
 *
 *   node tests/e2e/title-card.mjs [--peek DIR] [--only floral] [--port 5397]
 *
 * For every style × {16:9, 9:16, 1:1} × {normal, long, CJK, one long word} it checks: every title
 * font loaded (document.fonts.check), the layout boxes lie inside the safe area and keep their
 * order without overlapping, a transparent render leaves the outer 1 % border empty and has all
 * its ink inside the safe area (plus a small margin for accents and swashes), and each single
 * line's ink width matches the measured width (which catches a silent fallback font).
 * With --peek, PNGs are written to DIR (never into the repo).
 */
import { createServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? d : args[i + 1];
};
const peek = opt('peek', process.env.PEEK || '');
const only = opt('only', '');
const port = Number(opt('port', '5397'));

const { chromium } = await import('playwright');
const server = await createServer({ server: { port, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failures = 0;
const fail = (msg) => {
  failures++;
  console.log('FAIL ' + msg);
};
const inside = (r, s, tol = 0.5) => r.x0 >= s.x0 - tol && r.y0 >= s.y0 - tol && r.x1 <= s.x1 + tol && r.y1 <= s.y1 + tol;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`http://localhost:${port}/tests/e2e/title-card.html`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 120000 });
  for (const f of await page.evaluate(() => window.flourishInk())) {
    const { ink, bounds } = f;
    const ok = ['minX', 'minY'].every((k) => bounds[k] <= ink[k] + 0.01 && bounds[k] >= ink[k] - 0.06) && ['maxX', 'maxY'].every((k) => bounds[k] >= ink[k] - 0.01 && bounds[k] <= ink[k] + 0.06);
    if (!ok) fail(`flourish ${f.id}: FLOURISH_BOUNDS ${JSON.stringify(bounds)} do not match the drawn ink ${JSON.stringify(ink)}`);
  }
  const presets = (await page.evaluate(() => window.presets)).filter((p) => !only || only.split(',').includes(p));
  const sizes = [
    [1920, 1080],
    [1080, 1920],
    [1080, 1080],
  ];
  const texts = ['clair', 'long', 'cjk', 'word', 'bare'];
  let n = 0;
  for (const preset of presets)
    for (const [W, H] of sizes)
      for (const text of texts) {
        const name = `${preset}-${W}x${H}-${text}`;
        const r = await page.evaluate((job) => window.renderCard(job), { preset, W, H, text, checks: true, png: !!peek && (text === 'clair' || text === 'long') });
        n++;
        if (peek && r.png) {
          fs.mkdirSync(peek, { recursive: true });
          fs.writeFileSync(path.join(peek, `${name}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
        }
        for (const f of r.fontChecks) if (!f.ok) fail(`${name}: font ${f.family} ${f.weight} not loaded`);
        const c = r.checks;
        const safe = c.layout.safe;
        let prevBottom = -Infinity;
        for (const b of c.layout.blocks) {
          if (!inside(b.box, safe)) fail(`${name}: ${b.role} box ${JSON.stringify(b.box)} outside safe ${JSON.stringify(safe)}`);
          for (const d of b.divider?.boxes ?? []) if (!inside(d, safe)) fail(`${name}: ${b.role} divider outside safe area`);
          if (b.box.y0 < prevBottom - 0.5) fail(`${name}: ${b.role} overlaps the block above`);
          prevBottom = b.box.y1;
        }
        if (!c.borderClear) fail(`${name}: ink in the outer 1 % border ${JSON.stringify(c.ink)}`);
        const m = 0.035 * Math.min(W, H);
        if (c.ink && !inside(c.ink, { x0: safe.x0 - m, y0: safe.y0 - m, x1: safe.x1 + m, y1: safe.y1 + m })) fail(`${name}: ink ${JSON.stringify(c.ink)} outside the safe area`);
        for (const d of c.dividers)
          if (d.ink === null || Math.abs(d.ink - d.boxW) / d.boxW > 0.04) fail(`${name}: ${d.kind} divider below the ${d.role} drawn ${d.ink} px wide, box ${d.boxW.toFixed(1)} px`);
        if (text !== 'cjk')
          for (const w of c.widths) {
            if (w.ink === null || w.lines !== 1) continue;
            const err = Math.abs(w.ink - w.textW) / w.textW;
            if (err > 0.03) fail(`${name}: ${w.role} ink width ${w.ink} vs measured ${w.textW.toFixed(1)} (${(err * 100).toFixed(1)} %)`);
          }
        if (text === 'clair') console.log(`ok? ${name}  k=${r.k.toFixed(2)}  ${r.ms1.toFixed(0)}/${r.ms2.toFixed(0)} ms  ${r.blocks.map((b) => `${b.role}:${b.lines.length}@${b.px}${b.mode ? '/' + b.mode : ''}`).join(' ')}`);
      }
  // extras for the user's peek folder: fills, images, end card, animation frames
  if (peek) {
    const extra = [
      ['floral-pattern-marble', { preset: 'classic', look: { fill: 'pattern', pattern: 'marble', fillScope: 'all' } }],
      ['floral-image-fill', { preset: 'floral', look: { fill: 'image' } }],
      ['classic-image-bg', { preset: 'classic', look: { bg: 'image', dim: 0.5 } }],
      ['ornate-gradient', { preset: 'ornate', look: { fill: 'gradient', gradient: ['#ffd1f4', '#7aa7ff'], gradientAngle: 20 } }],
      ['end-floral', { preset: 'floral', text: 'end', end: true }],
      ['nocturne-floral', { preset: 'floral', text: 'nocturne' }],
      ['floral-t0.6', { preset: 'floral', reveal: false, t: 0.6 }],
      ['floral-t1.2', { preset: 'floral', reveal: false, t: 1.2 }],
      ['ornate-shine-t1.8', { preset: 'ornate', reveal: false, t: 1.8 }],
    ];
    for (const [name, j] of extra) {
      const r = await page.evaluate((job) => window.renderCard(job), { W: 1920, H: 1080, text: 'clair', png: true, ...j });
      fs.writeFileSync(path.join(peek, `x-${name}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
    }
  }
  console.log(`${n} cards checked, ${failures} failures`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failures ? 1 : 0);
