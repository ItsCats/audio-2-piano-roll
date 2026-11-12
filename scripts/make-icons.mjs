/**
 * Home-screen icons from public/favicon.svg (needs Playwright's Chromium):
 *
 *   node scripts/make-icons.mjs
 *
 * public/apple-touch-icon.png (180, square: iOS rounds the corners itself), icon-192.png and
 * icon-512.png (rounded, like the favicon) and icon-maskable-512.png (square, artwork inside the
 * 80 % safe circle), used by index.html and public/manifest.webmanifest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const svg = fs.readFileSync(path.join(pub, 'favicon.svg'), 'utf8');
const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/^<rect width="64" height="64" rx="14" fill="#101016"\/>/, '');
if (inner.length === svg.length) throw new Error('unexpected favicon.svg layout');
const BG = '#101016';
const variants = {
  'apple-touch-icon.png': { size: 180, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${BG}"/>${inner}</svg>` },
  'icon-192.png': { size: 192, svg },
  'icon-512.png': { size: 512, svg },
  'icon-maskable-512.png': {
    size: 512,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${BG}"/><g transform="translate(32 32) scale(0.78) translate(-32 -32)">${inner}</g></svg>`,
  },
};

const browser = await chromium.launch();
try {
  for (const [name, v] of Object.entries(variants)) {
    const page = await browser.newPage({ viewport: { width: v.size, height: v.size }, deviceScaleFactor: 1 });
    const src = `data:image/svg+xml;base64,${Buffer.from(v.svg).toString('base64')}`;
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="${src}" width="${v.size}" height="${v.size}" style="display:block">`);
    await page.locator('img').evaluate((img) => img.decode());
    await page.screenshot({ path: path.join(pub, name), omitBackground: true });
    await page.close();
    console.log(`public/${name} (${v.size}×${v.size})`);
  }
} finally {
  await browser.close();
}
