/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { thirdPartyLicenses } from './scripts/third-party-licenses.ts';

// jsPDF's optional helpers, only used by features we never call (doc.html, addSvgAsImage)
const jspdfStub = fileURLToPath(new URL('./src/lib/sheet/stub.ts', import.meta.url));

/**
 * Cross-origin isolation for the dev and preview servers, mirroring netlify.toml: the app routes'
 * documents (and every non-document response, e.g. worker scripts) get COOP same-origin + COEP
 * credentialless; unknown paths don't (src/lib/isolation.ts). Test harness pages under /tests/ stay non-isolated (their measurements
 * are single-threaded baselines) unless opened with ?coi=1.
 */
const ISOLATED_ROUTES = [/^\/$/, /^\/import$/, /^\/studio$/, /^\/studio\/[^/]+$/, /^\/library$/, /^\/settings$/, /^\/accuracy$/, /^\/credits$/, /^\/privacy$/, /^\/terms$/, /^\/copyright$/, /^\/index\.html$/];
function crossOriginIsolation(): Plugin {
  const apply = (req: { url?: string; headers: Record<string, string | string[] | undefined> }, res: { setHeader(k: string, v: string): unknown }) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const dest = req.headers['sec-fetch-dest'];
    const isDocument = dest === 'document' || dest === 'iframe' || (dest === undefined && String(req.headers.accept ?? '').includes('text/html'));
    if (isDocument) {
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const isolated = path.startsWith('/tests/') ? url.searchParams.get('coi') === '1' : ISOLATED_ROUTES.some((r) => r.test(path));
      if (!isolated) return;
    }
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  };
  return {
    name: 'piano2vision-cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((req, res, next) => (apply(req, res), next()));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => (apply(req, res), next()));
    },
  };
}

// dist/THIRD_PARTY_LICENSES.txt: licences of the npm packages bundled into the site (main build + workers)
const licenses = thirdPartyLicenses({
  header: [
    'Piano2Vision is free software under the GNU Affero General Public License, version 3 or later.',
    'Source code: https://github.com/ItsCats/audio-2-piano-roll (third-party notices: THIRD_PARTY_NOTICES.md there).',
    'The AI models in /models/ and the piano samples in /samples/ have their own LICENSE and README.md files next to them.',
    '',
    'Below: the npm packages (code, WebAssembly, fonts) bundled into this website, with their licences.',
  ].join('\n'),
});

export default defineConfig({
  plugins: [react(), tailwindcss(), crossOriginIsolation(), licenses.plugin()],
  worker: { format: 'es', plugins: () => [licenses.plugin()] },
  resolve: { alias: { html2canvas: jspdfStub, dompurify: jspdfStub, canvg: jspdfStub } },
  optimizeDeps: {
    include: [
      '@tensorflow/tfjs-core',
      '@tensorflow/tfjs-converter',
      '@tensorflow/tfjs-backend-cpu',
      '@tensorflow/tfjs-backend-webgl',
      '@tensorflow/tfjs-backend-wasm',
      'mediabunny',
      '@tonejs/midi',
      // UMD bundle; loaded lazily by the sheet-music view (src/lib/sheet/render.ts)
      'opensheetmusicdisplay',
      // loaded lazily for the sheet-music PDF (src/lib/sheet/pdf.ts); found late otherwise, and the
      // dev server then fails the import with 504 "Outdated Optimize Dep"
      'jspdf',
      'svg2pdf.js',
    ],
    // onnxruntime-web (SCNet separation worker) ships ready ESM; pre-bundling it breaks its WASM loader.
    // Its .wasm is imported with ?url (src/lib/separation/scnet.worker.ts), so it is served from our
    // own origin as a fingerprinted /assets file.
    exclude: ['onnxruntime-web'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  server: { port: 5173 },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
