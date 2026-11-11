/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  server: { port: 5173 },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
