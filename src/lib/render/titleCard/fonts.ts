/**
 * Title page fonts (SIL Open Font License 1.1, self-hosted from Fontsource; see src/lib/credits.ts).
 *
 * Nothing loads at app start: this module is imported dynamically by the export and by the title
 * page preview. The woff2 files are same-origin hashed /assets URLs (CSP font-src 'self'), and only
 * the faces a title page really uses are fetched, with the FontFace API under private "P2V" names.
 * Loading never blocks forever: after a timeout the fallback font is used and the caller is told.
 */
import cinzel400 from '@fontsource/cinzel/files/cinzel-latin-400-normal.woff2?url';
import cinzel400Ext from '@fontsource/cinzel/files/cinzel-latin-ext-400-normal.woff2?url';
import cinzel700 from '@fontsource/cinzel/files/cinzel-latin-700-normal.woff2?url';
import cinzel700Ext from '@fontsource/cinzel/files/cinzel-latin-ext-700-normal.woff2?url';
import cinzel900 from '@fontsource/cinzel/files/cinzel-latin-900-normal.woff2?url';
import cinzel900Ext from '@fontsource/cinzel/files/cinzel-latin-ext-900-normal.woff2?url';
import playfair400 from '@fontsource/playfair-display/files/playfair-display-latin-400-normal.woff2?url';
import playfair400Ext from '@fontsource/playfair-display/files/playfair-display-latin-ext-400-normal.woff2?url';
import playfair700 from '@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff2?url';
import playfair700Ext from '@fontsource/playfair-display/files/playfair-display-latin-ext-700-normal.woff2?url';
import playfair900 from '@fontsource/playfair-display/files/playfair-display-latin-900-normal.woff2?url';
import playfair900Ext from '@fontsource/playfair-display/files/playfair-display-latin-ext-900-normal.woff2?url';
import cormorant500 from '@fontsource/cormorant-garamond/files/cormorant-garamond-latin-500-normal.woff2?url';
import cormorant500Ext from '@fontsource/cormorant-garamond/files/cormorant-garamond-latin-ext-500-normal.woff2?url';
import cormorant600 from '@fontsource/cormorant-garamond/files/cormorant-garamond-latin-600-normal.woff2?url';
import cormorant600Ext from '@fontsource/cormorant-garamond/files/cormorant-garamond-latin-ext-600-normal.woff2?url';
import cormorant700 from '@fontsource/cormorant-garamond/files/cormorant-garamond-latin-700-normal.woff2?url';
import cormorant700Ext from '@fontsource/cormorant-garamond/files/cormorant-garamond-latin-ext-700-normal.woff2?url';
import garamond500 from '@fontsource/eb-garamond/files/eb-garamond-latin-500-normal.woff2?url';
import garamond500Ext from '@fontsource/eb-garamond/files/eb-garamond-latin-ext-500-normal.woff2?url';
import garamond700 from '@fontsource/eb-garamond/files/eb-garamond-latin-700-normal.woff2?url';
import garamond700Ext from '@fontsource/eb-garamond/files/eb-garamond-latin-ext-700-normal.woff2?url';
import vibes400 from '@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff2?url';
import vibes400Ext from '@fontsource/great-vibes/files/great-vibes-latin-ext-400-normal.woff2?url';
import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import interExt from '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url';
import { bumpFontEpoch } from './fontEpoch';
import { FAMILY, nearestWeight, type FontKey, type ResolvedLook } from './presets';
import { TEXT_ROLES, type TitleText } from './types';

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const NEEDS_EXT = /[\u0100-\u02ff\u1d00-\u1eff\u2c60-\u2c7f\ua720-\ua7ff]/;

interface FaceFiles {
  weight: string;
  latin: string;
  ext: string;
}

const FACES: Record<FontKey, FaceFiles[]> = {
  cinzel: [
    { weight: '400', latin: cinzel400, ext: cinzel400Ext },
    { weight: '700', latin: cinzel700, ext: cinzel700Ext },
    { weight: '900', latin: cinzel900, ext: cinzel900Ext },
  ],
  playfair: [
    { weight: '400', latin: playfair400, ext: playfair400Ext },
    { weight: '700', latin: playfair700, ext: playfair700Ext },
    { weight: '900', latin: playfair900, ext: playfair900Ext },
  ],
  cormorant: [
    { weight: '500', latin: cormorant500, ext: cormorant500Ext },
    { weight: '600', latin: cormorant600, ext: cormorant600Ext },
    { weight: '700', latin: cormorant700, ext: cormorant700Ext },
  ],
  garamond: [
    { weight: '500', latin: garamond500, ext: garamond500Ext },
    { weight: '700', latin: garamond700, ext: garamond700Ext },
  ],
  vibes: [
    { weight: '400', latin: vibes400, ext: vibes400Ext },
  ],
  inter: [{ weight: '100 900', latin: inter, ext: interExt }],
};

const DIGITS = /[0-9]/;

export interface FontNeed {
  font: FontKey;
  weight: number;
  ext: boolean;
}

/** The faces a title page with these texts needs (one per family + weight). */
export function neededFonts(look: ResolvedLook, texts: TitleText[]): FontNeed[] {
  const out = new Map<string, FontNeed>();
  const add = (font: FontKey, weight: number, s: string) => {
    const w = nearestWeight(font, weight);
    const key = `${font}|${w}`;
    const prev = out.get(key);
    const ext = NEEDS_EXT.test(s);
    if (prev) prev.ext ||= ext;
    else out.set(key, { font, weight: w, ext });
  };
  for (const text of texts)
    for (const role of TEXT_ROLES) {
      const s = text[role]?.trim();
      if (!s) continue;
      const spec = look.lines[role];
      add(spec.font, spec.weight, s);
      if (spec.digits && DIGITS.test(s)) add(spec.digits, spec.weight, '');
    }
  return [...out.values()];
}

type FontSet = FontFaceSet & { add(f: FontFace): FontFaceSet };
function fontSet(): FontSet | null {
  const g = globalThis as unknown as { document?: { fonts?: FontSet }; fonts?: FontSet };
  return g.document?.fonts ?? g.fonts ?? null;
}

const faces = new Map<string, FontFace>();
const familyName = (font: FontKey) => FAMILY[font].replace(/'/g, '');

function faceFor(font: FontKey, weight: number, ext: boolean): FontFace | null {
  if (typeof FontFace === 'undefined') return null;
  const files = FACES[font];
  const f = font === 'inter' ? files[0] : (files.find((x) => Number(x.weight) === weight) ?? files[0]);
  const key = `${font}|${f.weight}|${ext ? 'ext' : 'latin'}`;
  let face = faces.get(key);
  if (!face) {
    face = new FontFace(familyName(font), `url(${ext ? f.ext : f.latin}) format('woff2')`, { weight: f.weight, unicodeRange: ext ? LATIN_EXT : LATIN, display: 'block' });
    faces.set(key, face);
    fontSet()?.add(face);
  }
  return face;
}

function forget(face: FontFace) {
  try {
    (fontSet() as unknown as { delete?(f: FontFace): boolean })?.delete?.(face);
  } catch {
    /* not in the set */
  }
  for (const [k, v] of faces) if (v === face) faces.delete(k);
}

export interface FontResult {
  ok: boolean;
  /** families that did not load (the fallback font is used for them) */
  missing: string[];
}

/** Loads the faces a title page needs; resolves within `timeoutMs` whatever happens. */
export async function ensureTitleFonts(look: ResolvedLook, texts: TitleText[], timeoutMs = 8000): Promise<FontResult> {
  return loadNeeds(neededFonts(look, texts), timeoutMs);
}

/** Loads one face (e.g. the watermark's); resolves within `timeoutMs` whatever happens. */
export async function ensureFont(font: FontKey, weight: number, text: string, timeoutMs = 8000): Promise<FontResult> {
  return loadNeeds([{ font, weight: nearestWeight(font, weight), ext: NEEDS_EXT.test(text) }], timeoutMs);
}

async function loadNeeds(needs: FontNeed[], timeoutMs: number): Promise<FontResult> {
  const set = fontSet();
  if (!set || typeof FontFace === 'undefined') return { ok: false, missing: needs.map((n) => familyName(n.font)) };
  let fresh = false;
  const jobs: Promise<boolean>[] = [];
  for (const n of needs) {
    for (const ext of n.ext ? [false, true] : [false]) {
      const face = faceFor(n.font, n.weight, ext);
      if (!face) continue;
      if (face.status === 'loaded') continue;
      fresh = true;
      const f = face;
      jobs.push(
        Promise.race([
          f.load().then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
        ]).then((ok) => {
          // too slow or broken: take the face out again, so it can't arrive in the middle of an
          // export and change the letters after the layout was measured with the fallback font
          if (!ok && f.status !== 'loaded') forget(f);
          return ok;
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (fresh) bumpFontEpoch();
  const missing = needs.filter((n) => !set.check(`${n.font === 'inter' ? 400 : n.weight} 48px ${FAMILY[n.font]}`)).map((n) => familyName(n.font));
  return { ok: missing.length === 0, missing: [...new Set(missing)] };
}

export const TITLE_FONT_FILES = FACES;
