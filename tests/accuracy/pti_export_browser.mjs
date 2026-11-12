/**
 * Browser parity + speed of the piano specialist (src/lib/pianoSpecialist worker, onnxruntime-web WASM)
 * against the Python outputs written by pti_export_check.py, in Playwright Chromium.
 *
 *   node tests/accuracy/pti_export_browser.mjs --dir PARITY_DIR [--threads 1,3] [--port 5191] [--save] ID [...]
 *
 * PARITY_DIR holds <ID>.audio16k.f32 and <ID>.{torch,onnx}.{frame,onset,offset,velocity}.f32 (keep it
 * outside the repository: recordings are copyrighted). The page is cross-origin isolated (?coi=1, as the
 * app routes are) so more than one thread can be used. Each run starts a fresh worker. Prints one JSON
 * line per run: timings (model load from cache / network, session compile, inference), seconds per
 * audio minute, peak RSS of this Chromium, and per output the max / mean abs difference and the
 * agreement at the post-processor thresholds. With --save the browser maps are written back to
 * PARITY_DIR as <ID>.browser<threads>.<output>.f32. One model run at a time; 30 min timeout per run.
 */
import { createServer } from 'vite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const dir = opt('dir', null);
const port = +opt('port', '5191');
const threadList = opt('threads', '1,3').split(',').map(Number);
const save = flag('save');
const ids = args;
if (!dir || !ids.length) {
  console.error('usage: node tests/accuracy/pti_export_browser.mjs --dir PARITY_DIR [--threads 1,3] [--save] ID [...]');
  process.exit(2);
}
if (path.resolve(dir).startsWith(root + path.sep)) {
  console.error('--dir must be outside the repository');
  process.exit(2);
}
const plugin = {
  name: 'pti-parity-io',
  configureServer(srv) {
    srv.middlewares.use('/__pti', (req, res) => {
      const file = path.join(dir, path.basename(decodeURIComponent(req.url.replace(/^\//, '').split('?')[0])));
      if (!fs.existsSync(file)) return (res.statusCode = 404), res.end();
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', fs.statSync(file).size);
      fs.createReadStream(file).pipe(res);
    });
    srv.middlewares.use('/__ptiout', (req, res) => {
      if (req.method !== 'POST') return (res.statusCode = 405), res.end();
      const ws = fs.createWriteStream(path.join(dir, path.basename(decodeURIComponent(req.url.replace(/^\//, '')))));
      req.pipe(ws);
      ws.on('finish', () => res.end('ok'));
    });
  },
};

// RSS of OUR Chromium only (other browsers may run on this machine): node's process tree
function rssMB() {
  try {
    const rows = execSync('ps -eo pid=,ppid=,rss=').toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [pid, ppid] of rows) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(pid);
    const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
    let sum = 0;
    const st = [...(kids.get(process.pid) ?? [])];
    while (st.length) {
      const p = st.pop();
      sum += rss.get(p) ?? 0;
      st.push(...(kids.get(p) ?? []));
    }
    return sum / 1024;
  } catch {
    return 0;
  }
}

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), plugins: [plugin], server: { port, strictPort: true }, logLevel: 'error' });
await server.listen();
const { chromium } = await import('playwright');
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.error('[console]', m.text().slice(0, 300)));
  page.on('crash', () => console.error('[crash] page crashed'));
  page.setDefaultTimeout(30 * 60 * 1000);
  await page.goto(`http://localhost:${port}/tests/accuracy/pti_export_browser.html?coi=1`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
  for (const id of ids) {
    for (const threads of threadList) {
      const base = rssMB();
      let peak = base;
      const timer = setInterval(() => (peak = Math.max(peak, rssMB())), 250);
      const r = await page.evaluate(([i, t, s]) => window.runParity(i, t, s), [id, threads, save]);
      clearInterval(timer);
      r.rssBaseMB = Math.round(base);
      r.rssPeakMB = Math.round(peak);
      r.rssAfterMB = Math.round(rssMB());
      r.loadavg = os.loadavg().map((x) => +x.toFixed(2));
      console.log(JSON.stringify(r));
    }
  }
} finally {
  await browser.close();
  await server.close();
}
