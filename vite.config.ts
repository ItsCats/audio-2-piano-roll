/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';

/**
 * Cross-origin isolation for the dev and preview servers, mirroring netlify.toml: the app routes'
 * documents (and every non-document response, e.g. worker scripts) get COOP same-origin + COEP
 * credentialless; the YouTube import route (it embeds the YouTube player; src/lib/isolation.ts)
 * and unknown paths don't. Test harness pages under /tests/ stay non-isolated (their measurements
 * are single-threaded baselines) unless opened with ?coi=1.
 */
const ISOLATED_ROUTES = [/^\/$/, /^\/import$/, /^\/studio$/, /^\/studio\/[^/]+$/, /^\/library$/, /^\/settings$/, /^\/accuracy$/, /^\/credits$/, /^\/index\.html$/];
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

export default defineConfig({
  plugins: [react(), tailwindcss(), crossOriginIsolation()],
  worker: { format: 'es' },
  optimizeDeps: {
    include: [
      '@tensorflow/tfjs-core',
      '@tensorflow/tfjs-converter',
      '@tensorflow/tfjs-backend-cpu',
      '@tensorflow/tfjs-backend-webgl',
      '@tensorflow/tfjs-backend-wasm',
      'mediabunny',
      '@tonejs/midi',
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
