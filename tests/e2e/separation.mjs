/**
 * Headless check of the in-browser SCNet separation (src/lib/separation) in Playwright Chromium.
 *
 *   node tests/e2e/separation.mjs --out DIR [--port 5303] [--excerpt START,DUR] [--cancel] song.mp3 [...]
 *
 * Audio is streamed from its path through a dev-server middleware (never copied into the repo); the
 * stems the page produces are written to DIR (keep DIR outside the repo; songs may be copyrighted).
 * Prints one JSON line per file with timing, peak RSS of this Chromium, vocal presence, the timebase
 * check (our 44.1→22.05 kHz decimation vs the browser's 22.05 kHz decode) and lengths.
 * Compare with the python reference: tests/e2e/separation_compare.py.
 */
import { createServer } from 'vite';
import fs from 'node:fs';
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
const outDir = opt('out', null);
const port = +opt('port', '5303');
const [exStart, exDur] = (opt('excerpt', '0,0') || '0,0').split(',').map(Number);
const cancel = flag('cancel');
const songs = args;
if (!outDir || !songs.length) {
  console.error('usage: node tests/e2e/separation.mjs --out DIR [--port N] [--excerpt START,DUR] [--cancel] files...');
  process.exit(2);
}
if (path.resolve(outDir).startsWith(root + path.sep)) {
  console.error('--out must be outside the repository');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const mime = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };
const plugin = {
  name: 'separation-io',
  configureServer(srv) {
    srv.middlewares.use('/__sepaudio', (req, res) => {
      const file = songs[+decodeURIComponent(req.url.replace(/^\//, ''))];
      if (!file) return (res.statusCode = 404), res.end();
      res.setHeader('content-type', mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('content-length', fs.statSync(file).size);
      fs.createReadStream(file).pipe(res);
    });
    srv.middlewares.use('/__sepout', (req, res) => {
      if (req.method !== 'POST') return (res.statusCode = 405), res.end();
      const name = path.basename(decodeURIComponent(req.url.replace(/^\//, '')));
      const ws = fs.createWriteStream(path.join(outDir, name));
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
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.error('[console]', m.text().slice(0, 300)));
  page.on('crash', () => console.error('[crash] page crashed'));
  await page.goto(`http://localhost:${port}/tests/e2e/separation.html`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
  for (let i = 0; i < songs.length; i++) {
    const name = path.basename(songs[i]).replace(/\.[^.]+$/, '');
    const tag = exDur > 0 ? `${name}_${exStart}_${exDur}` : name;
    const base = rssMB();
    let peak = base;
    const timer = setInterval(() => (peak = Math.max(peak, rssMB())), 250);
    const t0 = Date.now();
    const r = await page.evaluate(([u, t, s, d]) => window.separateUrl(u, t, s, d), [`http://localhost:${port}/__sepaudio/${i}`, tag, exStart, exDur]);
    clearInterval(timer);
    r.wallMs = Date.now() - t0;
    r.secondsPerMinute = +((r.sepMs / 1000 / r.seconds) * 60).toFixed(1);
    r.rssBaseMB = Math.round(base);
    r.rssPeakMB = Math.round(peak);
    r.rssAfterMB = Math.round(rssMB());
    r.loadavg = (await import('node:os')).loadavg().map((x) => +x.toFixed(2));
    fs.writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify(r, null, 1));
    const ok = r.len22 === r.lenDecode22 && r.lenAccomp22 === r.len22 && r.decimateVsDecode22.lag === 0 && r.stemSumLag === 0;
    failed ||= !ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${JSON.stringify({ ...r, progress: r.progress.length })}`);
  }
  if (cancel) {
    const r = await page.evaluate((u) => window.cancelTest(u), `http://localhost:${port}/__sepaudio/0`);
    const rss = Math.round(rssMB());
    console.log(`${r.aborted ? 'PASS' : 'FAIL'} cancel ${JSON.stringify(r)} rssAfterCancelMB ${rss}`);
    failed ||= !r.aborted;
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
