/**
 * "Remove singing and drums" (Piano solo) through the app's REAL pipeline entry point (transcribeAudio, the
 * options an import passes) in Chromium, one fresh cross-origin-isolated tab per file, on a Vite dev server
 * of this checkout (or of another checkout with --root, e.g. an older commit for regression runs):
 *
 *   TMPDIR=/dev/shm node tests/accuracy/pianosep.mjs OUTDIR --variants bp.mix,sep,bp.part,spec.part [--root DIR] [--port 5941] [--force] FILES...
 *
 * Variants:
 *   bp.mix      "Piano solo", no separation (the option off)
 *   spec.mix    the high-accuracy piano model, no separation (the option off)
 *   sep         separateStems once (reused below as `separation`; any variant below needs it)
 *   bp.sepNow   Piano solo + { separation } without pianoPart (the separated flow without the option)
 *   bp.part     Piano solo + { separation, pianoPart: true }                  ("Remove singing and drums")
 *   spec.part   the same + engine 'piano-specialist'                           (with the high-accuracy model)
 *   bp.partReal / spec.partReal: { separate: true, pianoPart: true } (separation inside: whole-import time)
 *   full.mix / full.sep / full.blend: "Full song" without / with separation / with separation + pianoBlend
 * Writes OUTDIR/<file id>.json: notes per variant, info (warnings, separation), times, peak RSS of the largest
 * Chromium process per step. Score with tests/accuracy/pianosep_eval.py. Heavy: run one at a time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (k) => { const i = args.indexOf(`--${k}`); if (i < 0) return false; args.splice(i, 1); return true; };
const port = +opt('port', '5941');
const variants = opt('variants', 'bp.mix,sep,bp.part,spec.part').split(',');
const root = path.resolve(opt('root', here));
const force = flag('force');
const [outDir, ...songs] = args;
if (!outDir || !songs.length) {
  console.error('usage: node tests/accuracy/pianosep.mjs OUTDIR [--variants ...] [--root DIR] FILES...');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const mime = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const plugin = {
  name: 'pianosep-io',
  configureServer(srv) {
    srv.middlewares.use('/__accaudio', (req, res) => {
      const file = songs[+decodeURIComponent(req.url.replace(/^\//, ''))];
      if (!file) { res.statusCode = 404; return res.end(); }
      res.setHeader('content-type', mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
      res.setHeader('content-length', fs.statSync(file).size);
      fs.createReadStream(file).pipe(res);
    });
  },
};
const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), plugins: [plugin], server: { port, strictPort: true }, logLevel: 'error', ...(process.env.ACC_VITE_CACHE ? { cacheDir: path.resolve(process.env.ACC_VITE_CACHE) } : {}) });
await server.listen();
const browser = await chromium.launch();
const treePids = () => {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1];
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(+d);
    } catch {}
  }
  const out = [];
  const stack = [...(kids.get(process.pid) ?? [])];
  while (stack.length) {
    const p = stack.pop();
    stack.push(...(kids.get(p) ?? []));
    try { if (/chrom|headless_shell/i.test(fs.readFileSync(`/proc/${p}/cmdline`, 'utf8'))) out.push(p); } catch {}
  }
  return out;
};
let step = null;
const peaks = {};
const sampler = setInterval(() => {
  if (!step) return;
  let mx = 0;
  for (const p of treePids()) {
    try { const m = fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB/m); if (m) mx = Math.max(mx, +m[1]); } catch {}
  }
  peaks[step] = Math.max(peaks[step] ?? 0, Math.round(mx / 1024));
}, 400);

try {
  for (let i = 0; i < songs.length; i++) {
    const name = path.basename(songs[i]).replace(/\.[^.]+$/, '');
    const out = path.join(outDir, `${name}.json`);
    if (!force && fs.existsSync(out)) { console.log('skip', name); continue; }
    for (const k of Object.keys(peaks)) delete peaks[k];
    const t0 = Date.now();
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
    await page.exposeFunction('__mark', (s) => { step = s; });
    await page.goto(`http://localhost:${port}/tests/e2e/accuracy.html?coi=1`);
    await page.waitForFunction(() => document.getElementById('log')?.textContent === 'ready', null, { timeout: 180000 });
    const res = await page.evaluate(async ([u, variants]) => {
      const P = await import('/src/lib/transcription/pipeline.ts');
      const { separateStems } = await import('/src/lib/separation/index.ts');
      const piano = P.EXTRACTION_PRESETS.piano;
      const mix = P.EXTRACTION_PRESETS.mix;
      const slim = (ns) => ns.map((n) => ({ midi: n.midi, start: +n.start.toFixed(4), dur: +n.dur.toFixed(4), vel: +n.vel.toFixed(3), hand: n.hand, ...(n.role ? { role: n.role } : {}), ...(n.src ? { src: n.src } : {}) }));
      const R = { variants: {}, ms: {}, info: {}, stages: {} };
      const blob = await (await fetch(u)).blob();
      let sep = null;
      const run = async (k, params, opts) => {
        if (!variants.includes(k)) return;
        await window.__mark(k);
        const stages = [];
        const t = performance.now();
        try {
          const r = await P.transcribeAudio(blob, params, (e) => { const s = `${e.stage}|${(e.detail ?? '').replace(/\d+/g, '#')}`; if (stages.at(-1) !== s) stages.push(s); }, undefined, opts);
          R.variants[k] = slim(r.notes);
          R.info[k] = { method: r.info.method, warnings: r.info.warnings, separation: r.info.separation ?? null, separated: !!r.info.separated, pianoBlend: r.info.pianoBlend ?? null, duration: r.duration, failure: r.separationFailure ?? null };
        } catch (e) {
          R.errors = { ...(R.errors ?? {}), [k]: String(e?.message ?? e) };
          R.variants[k] = [];
        } finally {
          R.ms[k] = Math.round(performance.now() - t);
          R.stages[k] = stages;
        }
      };
      await run('bp.mix', piano, {});
      await run('spec.mix', piano, { engine: 'piano-specialist' });
      await run('full.mix', mix, {});
      const needSep = variants.some((v) => ['bp.sepNow', 'bp.part', 'spec.part', 'full.sep', 'full.blend'].includes(v));
      if (needSep) {
        await window.__mark('sep');
        const t = performance.now();
        sep = await separateStems(blob, () => {});
        R.ms.sep = Math.round(performance.now() - t);
        R.vocalPresence = sep.vocalPresence;
        R.sepThreads = sep.threads;
      }
      await run('bp.sepNow', piano, { separation: sep });
      await run('bp.part', piano, { separation: sep, pianoPart: true });
      await run('spec.part', piano, { separation: sep, pianoPart: true, engine: 'piano-specialist' });
      await run('full.sep', mix, { separation: sep });
      await run('full.blend', mix, { separation: sep, pianoBlend: true });
      sep = null;
      await run('bp.partReal', piano, { separate: true, pianoPart: true });
      await run('spec.partReal', piano, { separate: true, pianoPart: true, engine: 'piano-specialist' });
      await window.__mark(null);
      return R;
    }, [`http://localhost:${port}/__accaudio/${i}`, variants]);
    await page.close();
    res.peakMB = { ...peaks };
    res.wallMs = Date.now() - t0;
    res.file = path.resolve(songs[i]);
    fs.writeFileSync(out, JSON.stringify(res));
    console.log(name, 'wall', (res.wallMs / 1000).toFixed(0), 's', JSON.stringify(res.ms), JSON.stringify(res.peakMB), res.errors ? JSON.stringify(res.errors) : '');
  }
} finally {
  clearInterval(sampler);
  await browser.close();
  await server.close();
}
