/**
 * Measures the homr reader (src/lib/omr/homr) on a PRODUCTION build served with netlify.toml's headers
 * (CSP, cross-origin isolation on the app routes, the long cache header on /models/homr/*), in
 * Playwright Chromium. Page images (PNG / JPEG) are decoded in the page with createImageBitmap, as the
 * import screen does. Writes OUT/<category>/<name>.musicxml for the scorers (tests/homr/score_out.sh,
 * compare.py) and OUT/runs.jsonl (time, stages, memory, download per page).
 *
 *   node tests/e2e/homr-prod.mjs --testset DIR --out DIR [--dist DIR] [--no-build] [--cats clean,photo]
 *        [--only gen00,BWV] [--mode isolated|plain] [--threads N] [--throttle 4] [--release] [--quads]
 *
 * --mode isolated: the harness is served at /import (an isolated app route: COOP + COEP), so WASM threads
 *   are available (default wasmThreads(4) = cores - 1, at most 4); plain: at /homr-plain (not isolated:
 *   one thread, like browsers without cross-origin isolation).
 * --throttle R: Chromium's CPU throttling (DevTools) at rate R on the page and, where the protocol allows,
 *   on its workers; the script prints which targets accepted it.
 * The test set (TESTSET/<category>/*.png|jpg, + *.quad.json corners for photos) stays outside the repo.
 */
import { build } from 'vite';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
const testset = path.resolve(opt('testset', ''));
const out = path.resolve(opt('out', 'homr-prod-out'));
const dist = path.resolve(opt('dist', path.join(out, 'dist')));
const cats = opt('cats', 'clean,clean_real,photo,photo_real').split(',');
const only = opt('only', '').split(',').filter(Boolean);
const mode = opt('mode', 'isolated');
const threads = opt('threads', '') ? +opt('threads', '') : undefined;
const throttle = +opt('throttle', '1');
const release = flag('release') ? true : undefined;
const useQuads = flag('quads');
const port = +opt('port', '5191');

// ------------------------------------------------------------------ build
if (!flag('no-build')) {
  await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: { main: path.join(root, 'index.html'), homr: path.join(root, 'tests/e2e/homr.html') } } },
  });
}

// ------------------------------------------------------------------ server with netlify.toml's headers
/** [[headers]] blocks of netlify.toml (for + values). */
function netlifyHeaders(text) {
  const rules = [];
  let cur = null;
  let inValues = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[[')) {
      cur = line === '[[headers]]' ? { for: '', values: {} } : null;
      if (cur) rules.push(cur);
      inValues = false;
    } else if (line.startsWith('[')) {
      inValues = !!cur && line === '[headers.values]';
    } else if (cur) {
      const m = line.match(/^([\w-]+)\s*=\s*"(.*)"$/);
      if (!m) continue;
      if (inValues) cur.values[m[1]] = m[2];
      else if (m[1] === 'for') cur.for = m[2];
    }
  }
  return rules.map((r) => ({ ...r, re: new RegExp(`^${r.for.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:[a-z]+/g, '[^/]+')}$`) }));
}
const rules = netlifyHeaders(fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.bin': 'application/octet-stream', '.onnx': 'application/octet-stream' };
const harness = path.join(dist, 'tests/e2e/homr.html');
const served = new Map(); // path → bytes
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  let file;
  if (p === '/import' || p === '/homr-plain') file = harness;
  else if (p.startsWith('/__testset/')) file = path.join(testset, p.slice('/__testset/'.length));
  else {
    file = path.join(dist, p);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  }
  for (const r of rules) if (r.re.test(p)) for (const [k, v] of Object.entries(r.values)) res.setHeader(k, v);
  res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
  const body = fs.readFileSync(file);
  res.setHeader('Content-Length', body.length);
  if (!p.startsWith('/__testset/')) served.set(p, (served.get(p) ?? 0) + body.length);
  res.end(body);
});
await new Promise((ok) => server.listen(port, '127.0.0.1', ok));

// ------------------------------------------------------------------ memory: the browser's process tree
const tag = `--homr-measure-${process.pid}`;
function tree() {
  const rows = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map((pid) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
      return { pid: +pid, ppid };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const top = rows.find((r) => {
    try {
      return fs.readFileSync(`/proc/${r.pid}/cmdline`, 'utf8').includes(tag);
    } catch {
      return false;
    }
  });
  if (!top) return [];
  const kids = new Map();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const all = [];
  const todo = [top.pid];
  while (todo.length) {
    const p = todo.pop();
    all.push(p);
    todo.push(...(kids.get(p) ?? []));
  }
  return all;
}
/** PSS of the whole browser and RSS of its largest renderer, MB. */
function memory(pids) {
  let pss = 0;
  let renderer = 0;
  for (const pid of pids) {
    try {
      const s = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      pss += +(s.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0) / 1024;
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmd.includes('--type=renderer')) renderer = Math.max(renderer, +(s.match(/^Rss:\s+(\d+)/m)?.[1] ?? 0) / 1024);
    } catch {
      /* process ended */
    }
  }
  return { pss, renderer };
}
const loadavg = () => fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ');
/** CPU time (clock ticks) of every process. */
function cpuTicks() {
  const m = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      m.set(+d, { t: +f[11] + +f[12], comm: st.slice(st.indexOf('(') + 1, st.lastIndexOf(')')) });
    } catch {
      /* ended */
    }
  }
  return m;
}
/** Cores used by processes outside this measurement (other jobs) between two cpuTicks() snapshots. */
function otherCores(a, b, mine, seconds) {
  let ticks = 0;
  const names = new Map();
  for (const [pid, v] of b) {
    if (mine.has(pid) || pid === process.pid) continue;
    const d = v.t - (a.get(pid)?.t ?? 0);
    if (d <= 0) continue;
    ticks += d;
    names.set(v.comm, (names.get(v.comm) ?? 0) + d);
  }
  const top = [...names].sort((x, y) => y[1] - x[1]).slice(0, 3).filter(([, t]) => t / 100 / seconds > 0.1).map(([n, t]) => `${n} ${(t / 100 / seconds).toFixed(1)}`);
  return { cores: +(ticks / 100 / seconds).toFixed(2), top };
}

// ------------------------------------------------------------------ run
const { chromium } = await import('playwright');
const debugPort = port + 1000;
const browser = await chromium.launch({ args: [tag, ...(throttle > 1 ? [`--remote-debugging-port=${debugPort}`] : [])] });
fs.mkdirSync(out, { recursive: true });
const runs = fs.createWriteStream(path.join(out, 'runs.jsonl'), { flags: 'a' });
let pids = [];
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  const csp = [];
  page.on('console', (m) => /Content Security Policy|Refused to/.test(m.text()) && csp.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}${mode === 'isolated' ? '/import' : '/homr-plain'}`);
  await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
  const env = await page.evaluate(() => ({ isolated: self.crossOriginIsolated, cores: navigator.hardwareConcurrency, ua: navigator.userAgent }));
  console.log(`mode ${mode}: crossOriginIsolated=${env.isolated}, ${env.cores} cores, threads ${threads ?? 'default'}, throttle ${throttle}x, release ${release ?? 'default'}`);
  if (throttle > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    // workers (the reader's worker and onnxruntime's thread workers) are separate targets: a raw CDP
    // connection to the browser (Playwright's own sessions cannot address them)
    const ver = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((ok, bad) => ((ws.onopen = ok), (ws.onerror = bad)));
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    };
    const send = (method, params = {}, sessionId) =>
      new Promise((ok) => {
        const i = ++id;
        pending.set(i, ok);
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const ok = new Set();
    const throttleWorkers = async () => {
      const { result } = await send('Target.getTargets');
      for (const t of (result?.targetInfos ?? []).filter((t) => /worker/.test(t.type) && !ok.has(t.targetId))) {
        ok.add(t.targetId);
        const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const r = a.result ? await send('Emulation.setCPUThrottlingRate', { rate: throttle }, a.result.sessionId) : a;
        console.log(`throttle ${t.type} ${t.title || t.url}: ${r.error ? `not accepted (${r.error.message})` : 'ok'}`);
      }
    };
    setInterval(() => throttleWorkers().catch(() => {}), 500).unref();
  }
  pids = tree();
  const baseMem = memory(pids);
  console.log(`load ${loadavg()}; browser PSS ${Math.round(baseMem.pss)} MB, renderer RSS ${Math.round(baseMem.renderer)} MB before the first page`);
  let first = true;
  for (const cat of cats) {
    const dir = path.join(testset, cat);
    if (!fs.existsSync(dir)) continue;
    fs.mkdirSync(path.join(out, cat), { recursive: true });
    for (const f of fs.readdirSync(dir).filter((x) => /\.(png|jpe?g)$/.test(x)).sort()) {
      const name = f.replace(/\.(png|jpe?g)$/, '');
      if (only.length && !only.some((o) => name.startsWith(o))) continue;
      const qf = path.join(dir, `${name}.quad.json`);
      const quad = useQuads && fs.existsSync(qf) ? JSON.parse(fs.readFileSync(qf, 'utf8')) : null;
      const before = memory((pids = tree()));
      const servedBefore = new Map(served);
      let peak = { ...before };
      const cpu0 = cpuTicks();
      const mine = new Set(pids);
      const timer = setInterval(() => {
        const m = memory((pids = tree()));
        peak = { pss: Math.max(peak.pss, m.pss), renderer: Math.max(peak.renderer, m.renderer) };
        for (const p of pids) mine.add(p);
      }, 250);
      const la0 = loadavg();
      try {
        const r = await page.evaluate(([u, o]) => window.readUrl(u, o), [`/__testset/${cat}/${f}`, { threads, release, quad: quad?.quad ?? quad }]);
        clearInterval(timer);
        const after = memory((pids = tree()));
        for (const p of pids) mine.add(p);
        const others = otherCores(cpu0, cpuTicks(), mine, r.seconds);
        let dl = 0;
        const dlFiles = {};
        for (const [p, b] of served) {
          const d = b - (servedBefore.get(p) ?? 0);
          if (d > 0) {
            dl += d;
            dlFiles[p] = d;
          }
        }
        fs.writeFileSync(path.join(out, cat, `${name}.musicxml`), r.musicXml);
        const s = r.stats;
        const row = { cat, name, mode, threads: s.threads, throttle, quads: !!quad, first, seconds: r.seconds, stageSeconds: r.stageSeconds, segS: +(s.segmentMs / 1000).toFixed(1), encS: +(s.encodeMs / 1000).toFixed(1), decS: +(s.decodeMs / 1000).toFixed(1), staves: r.staves, lines: r.lines, w: r.w, h: r.h, warnings: r.warnings, memBefore: before, memPeak: peak, memAfter: after, downloadBytes: dl, downloadFiles: first ? dlFiles : undefined, load: `${la0} → ${loadavg()}`, others };
        runs.write(JSON.stringify(row) + '\n');
        console.log(`${cat}/${name} ${r.seconds}s (seg ${row.segS} enc ${row.encS} dec ${row.decS}; stages ${JSON.stringify(r.stageSeconds)}) staves ${r.staves} lines ${r.lines} threads ${s.threads} PSS ${Math.round(before.pss)}→peak ${Math.round(peak.pss)}→${Math.round(after.pss)} MB renderer peak ${Math.round(peak.renderer)} MB dl ${(dl / 1e6).toFixed(1)} MB load ${row.load}; other jobs used ${others.cores} cores${others.top.length ? ` (${others.top.join(', ')})` : ''}`);
      } catch (e) {
        clearInterval(timer);
        console.log(`${cat}/${name} ERROR ${e.message.split('\n')[0]}`);
        runs.write(JSON.stringify({ cat, name, mode, error: e.message.split('\n')[0] }) + '\n');
      }
      first = false;
    }
  }
  if (csp.length) console.log(`CSP violations: ${csp.length}\n  ${[...new Set(csp)].slice(0, 5).join('\n  ')}`);
  else console.log('CSP violations: none');
} finally {
  runs.end();
  await browser.close();
  server.close();
}
