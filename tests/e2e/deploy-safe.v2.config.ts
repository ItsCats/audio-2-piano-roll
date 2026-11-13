/**
 * The same app with every script file renamed (assets/<name>-v2-<hash>.js): stands in for "the
 * next deploy" in tests/e2e/deploy-safe.mjs.
 */
import { mergeConfig } from 'vite';
import base from '../../vite.config';

export default mergeConfig(base, {
  build: {
    rollupOptions: {
      output: { entryFileNames: 'assets/[name]-v2-[hash].js', chunkFileNames: 'assets/[name]-v2-[hash].js' },
    },
  },
});
