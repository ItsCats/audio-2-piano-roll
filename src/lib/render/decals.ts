/**
 * Note decals: an image or an original procedural pattern painted inside every note.
 *
 * CONTRACT (used by renderer.ts — keep these signatures):
 *  - DECAL_PATTERNS: built-in, ORIGINAL patterns (procedurally drawn, deterministic, no
 *    external assets, no copied artwork). Each draws one seamless tile.
 *  - getPatternTile(id, size): returns a cached seamless tile canvas for a pattern.
 *  - paintNoteDecal(ctx, rect, radius, p): fills the note's rounded rect with the decal.
 */
import type { DecalSettings } from './settings';
import type { AnyCanvas, Ctx2D, RGB } from './color';

export interface DecalPattern {
  id: string;
  name: string;
  /** Draw one seamless tile of `size`×`size` px. Must be deterministic. */
  draw(ctx: Ctx2D, size: number): void;
}

export const DECAL_PATTERNS: DecalPattern[] = [];

export function getPatternTile(id: string, size = 512): AnyCanvas | null {
  void id;
  void size;
  return null;
}

export interface NoteDecalParams {
  /** decal source image (pattern tile or user image) */
  image: CanvasImageSource;
  imageWidth: number;
  imageHeight: number;
  settings: DecalSettings;
  /** the note's display colour (hand / pitch / single colour, already highlight-adjusted) */
  color: RGB;
  noteId: number;
  /** y of the note's bottom edge for 'note' anchoring (so the decal moves with the note) */
  anchorY: number;
  /** renderer scale (canvas height / 1080) */
  scale: number;
  /** true when the note is currently sounding */
  active: boolean;
}

/** Paint the decal inside the rounded rect. Must leave ctx state as it found it. */
export function paintNoteDecal(ctx: Ctx2D, rect: { x: number; y: number; w: number; h: number }, radius: number, p: NoteDecalParams): void {
  void ctx;
  void rect;
  void radius;
  void p;
}
