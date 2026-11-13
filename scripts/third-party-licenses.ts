/**
 * Build step: writes dist/THIRD_PARTY_LICENSES.txt, the licence texts of every npm package whose code or files
 * (scripts, workers, WASM, fonts, CSS) end up in the built site. Vite strips most licence comments when it
 * minifies, so this file carries the notices the MIT/BSD/Apache/OFL/MPL/LGPL licences ask for in what is served.
 *
 * How: every module id loaded by the main build and by each worker build, plus the source paths of emitted
 * assets (fonts referenced from CSS), is mapped to its package under node_modules; for each package the
 * name, version, declared licence and its LICENSE / LICENCE / COPYING / NOTICE files are written out.
 * Over-inclusion is harmless (a module that was loaded but tree-shaken away still gets listed).
 *
 * Use one collector for the main build and the worker builds:
 *   const licenses = thirdPartyLicenses();
 *   plugins: [..., licenses.plugin()], worker: { plugins: () => [licenses.plugin()] }
 * Only the main build writes the file; the worker builds only collect.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Plugin } from 'vite';

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\b|[-_.]|$)/i;

/**
 * Packages whose published files already contain other packages (pre-bundled UMD/ESM builds), so those never show up
 * as modules of their own: OpenSheetMusicDisplay's build bundles its dependencies, and onnxruntime-web's
 * `onnxruntime-web/wasm` bundle inlines onnxruntime-common. Checked against opensheetmusicdisplay 2.2.1 and
 * onnxruntime-web 1.31.1.
 */
const BUNDLED_INSIDE: Record<string, string[]> = {
  opensheetmusicdisplay: ['jszip', 'loglevel', 'typescript-collections', 'vexflow'],
  'onnxruntime-web': ['onnxruntime-common'],
};

/** Extra notices for packages whose published files leave something out. */
const EXTRA_NOTES: Record<string, string> = {
  'onnxruntime-web':
    'Its WebAssembly build (ort-wasm-*.wasm) also contains third-party code; their notices are in ONNX Runtime\'s\nThirdPartyNotices.txt: https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt',
};

/** Package root ("…/node_modules/@scope/name" or "…/node_modules/name") of a file path or module id, or null. */
export function packageRootOf(id: string): string | null {
  const path = id.replace(/^\0+/, '').split('?')[0].replace(/\\/g, '/');
  const i = path.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const rest = path.slice(i + '/node_modules/'.length).split('/');
  const n = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length < n || !rest[n - 1]) return null;
  return path.slice(0, i) + '/node_modules/' + rest.slice(0, n).join('/');
}

function licenseFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isFile() && LICENSE_FILE.test(name)) out.push(p);
      // licence folders shipped next to vendored code (e.g. @mediabunny/aac-encoder/licenses/ffmpeg)
      else if (st.isDirectory() && depth < 2 && /^licen[cs]es?$|^ffmpeg$/i.test(name)) walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  return out;
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/** Distinct copyright lines in the files the build loaded from a package (for packages without a licence file). */
function copyrightLines(files: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const f of files) {
    const path = f.replace(/^\0+/, '').split('?')[0];
    if (!/\.(m?js|cjs|css)$/.test(path) || !existsSync(path)) continue;
    for (const m of readFileSync(path, 'utf8').matchAll(/Copyright\s+(?:\(c\)\s*)?\d{4}[^\n*"'`]{0,100}|Copyright\s+\(c\)\s+[A-Z][^\n*"'`]{0,100}/g)) {
      found.add(m[0].trim());
      if (found.size >= 12) return [...found];
    }
  }
  return [...found];
}

/** The "License" section at the end of a README, if it has one. */
function readmeLicense(root: string): string | null {
  const readme = readdirSync(root).find((n) => /^readme(\.md|\.txt)?$/i.test(n));
  if (!readme) return null;
  const lines = readFileSync(join(root, readme), 'utf8').split('\n');
  const i = lines.findLastIndex((l) => /^(#+\s*)?licen[cs]e\b/i.test(l.trim()));
  return i >= 0 && lines.length - i <= 60 ? lines.slice(i).join('\n').trimEnd() : null;
}

function describe(root: string, loaded: Iterable<string>, needs: Set<string>): string {
  let pkg: { name?: string; version?: string; license?: unknown; licenses?: unknown; author?: unknown; homepage?: string; repository?: unknown } = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    /* no package.json: list the folder name only */
  }
  const name = pkg.name ?? root.split('/node_modules/').pop()!;
  const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'UNKNOWN');
  const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository as { url?: string } | undefined)?.url;
  const author = typeof pkg.author === 'string' ? pkg.author : (pkg.author as { name?: string } | undefined)?.name;
  const lines = [`${name}@${pkg.version ?? '?'}`, `License: ${license}`];
  if (author) lines.push(`Author: ${author}`);
  if (repo || pkg.homepage) lines.push(`Source: ${repo ?? pkg.homepage}`);
  if (EXTRA_NOTES[name]) lines.push('', EXTRA_NOTES[name]);
  const files = licenseFiles(root);
  if (!files.length) {
    lines.push('', `(The package ships no licence file; it declares "${license}" in its package.json.)`);
    const notices = copyrightLines(loaded);
    if (notices.length) lines.push('', 'Copyright notices found in its code:', ...notices.map((n) => `  ${n}`));
    const section = readmeLicense(root);
    if (section) lines.push('', '----- licence section of its README -----', section);
    if (/^MIT$/i.test(license)) {
      if (!section?.includes('Permission is hereby granted')) lines.push('', '----- MIT License -----', MIT_TEXT);
    } else if (!section) needs.add(license);
  }
  for (const f of files) lines.push('', `----- ${f.slice(root.length + 1)} -----`, readFileSync(f, 'utf8').trimEnd());
  return lines.join('\n');
}

export function thirdPartyLicenses(options: { fileName?: string; header?: string } = {}) {
  const roots = new Map<string, Set<string>>();
  let projectRoot = process.cwd();
  const add = (id: string | null | undefined) => {
    // asset source paths (originalFileNames) are relative to the project root
    const r = id ? packageRootOf(id.startsWith('\0') || isAbsolute(id) ? id : join(projectRoot, id)) : null;
    if (!r || !existsSync(r)) return;
    if (!roots.has(r)) roots.set(r, new Set());
    roots.get(r)!.add(id!);
  };
  return {
    roots,
    plugin(): Plugin {
      let isWorker = false;
      return {
        name: 'piano2vision-third-party-licenses',
        apply: 'build',
        configResolved(config) {
          isWorker = config.isWorker;
          projectRoot = config.root;
        },
        buildEnd() {
          for (const id of this.getModuleIds()) add(id);
        },
        generateBundle(_out, bundle) {
          for (const file of Object.values(bundle)) {
            if (file.type === 'asset') for (const src of file.originalFileNames ?? []) add(src);
            else for (const id of Object.keys(file.modules)) add(id);
          }
          if (isWorker) return;
          const header =
            options.header ??
            'Third-party software bundled into this website, with its licences. The site itself is licensed separately (see LICENSE in its source).';
          for (const root of [...roots.keys()]) {
            for (const dep of BUNDLED_INSIDE[root.split('/node_modules/').pop()!] ?? []) {
              const dir = [join(root, 'node_modules', dep), join(projectRoot, 'node_modules', dep)].find((d) => existsSync(join(d, 'package.json')));
              if (dir && !roots.has(dir)) {
                const code = [dir, join(dir, 'dist'), join(dir, 'dist', 'esm')].filter((d) => existsSync(d) && statSync(d).isDirectory());
                roots.set(dir, new Set(code.flatMap((d) => readdirSync(d).filter((n) => /\.(m?js|cjs)$/.test(n)).map((n) => join(d, n)))));
              } else if (!dir) this.warn(`${dep} (bundled inside ${root}) not found in node_modules`);
            }
          }
          const rule = '\n\n' + '='.repeat(78) + '\n\n';
          const needs = new Set<string>();
          const parts = [...roots.keys()]
            .sort((a, b) => (a.split('/node_modules/').pop()! < b.split('/node_modules/').pop()! ? -1 : 1))
            .map((r) => describe(r, roots.get(r)!, needs));
          // full licence texts for packages that only name their licence
          const fullTexts: Record<string, string> = { 'Apache-2.0': join(projectRoot, 'public/models/basic-pitch/LICENSE') };
          for (const id of needs) {
            const f = fullTexts[id];
            if (f && existsSync(f)) parts.push(`Full text of the ${id} licence (referred to above)\n\n${readFileSync(f, 'utf8').trimEnd()}`);
            else this.warn(`no licence text found for ${id}`);
          }
          this.emitFile({ type: 'asset', fileName: options.fileName ?? 'THIRD_PARTY_LICENSES.txt', source: `${header}${rule}${parts.join(rule)}\n` });
        },
      };
    },
  };
}
