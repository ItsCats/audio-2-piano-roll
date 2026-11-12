// @tonejs/midi is CommonJS; Vite's SSR loader can't import its named export, so tests/sheet/export.mjs aliases it here.
import { createRequire } from 'node:module';
export const Midi = createRequire(import.meta.url)('@tonejs/midi').Midi;
