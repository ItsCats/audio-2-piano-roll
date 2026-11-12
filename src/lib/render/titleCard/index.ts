/**
 * Title page and end card for exported videos.
 *
 * Pure modules are re-exported here. Two are left out on purpose: fonts.ts (import it
 * dynamically, so the font files are only fetched when a title page is shown) and exportHooks.ts
 * (the export's integration, imported by src/lib/export/videoExport.ts).
 */
export * from './types';
export * from './presets';
export * from './settings';
export * from './layout';
export * from './draw';
export * from './timeline';
export { FILL_PATTERNS, getFillTile, patternInfo } from './patterns';
export { drawCardBackground, type CardImages } from './background';
