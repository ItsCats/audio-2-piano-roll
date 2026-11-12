/** Title page: layout geometry, line breaking, timeline / track wrappers and saved settings. */
import { describe, expect, it } from 'vitest';
import { BELOW_GAP, balancedBreaks, layoutTitleCard, splitGraphemes, type Measurer, type Rect, type TitleLayout } from '../../src/lib/render/titleCard/layout';
import { FLOURISH_BOUNDS } from '../../src/lib/render/titleCard/flourishBounds';
import { adaptLook, hexLuminance } from '../../src/lib/render/titleCard/contrast';
import { TITLE_PRESETS, resolveLook } from '../../src/lib/render/titleCard/presets';
import { DEFAULT_LOOK, DEFAULT_TITLE_CARD, type TitleLook, type TitleText } from '../../src/lib/render/titleCard/types';
import { cardTimeline, endOpacity, shiftAudio, shiftVideo, titleOpacity, totalSeconds } from '../../src/lib/render/titleCard/timeline';
import { clampDuration, defaultTextForSong, endCardText, sanitizeTitleCard, splitTitle, textForSong, trimSongs } from '../../src/lib/render/titleCard/settings';

// ---------------------------------------------------------------------------------------
// fake measurer: every grapheme is 0.62 em wide (wide-ish caps), CJK 1 em, space 0.3 em
// ---------------------------------------------------------------------------------------
const pxOf = (font: string) => parseFloat(/([\d.]+)px/.exec(font)![1]);
const fake: Measurer = {
  width(font, s) {
    const px = pxOf(font);
    return splitGraphemes(s).reduce((w, g) => w + (g === ' ' ? 0.3 : /[぀-鿿]/.test(g) ? 1 : 0.62) * px, 0);
  },
  extent(font) {
    const px = pxOf(font);
    return { asc: 0.7 * px, desc: 0.22 * px };
  },
};

const TEXTS: Record<string, TitleText> = {
  short: { title: 'Clair de Lune', subtitle: 'Suite Bergamasque', composer: 'Debussy', credit: 'Piano2Vision', small: 'For you' },
  long: {
    title: 'The Most Wonderful Moonlight Variations Ever Written For The Piano In Winter',
    subtitle: 'Suite for the Long Winter Evenings, Book Two, Opus Forty',
    composer: 'Johann Sebastian Bach and Carl Philipp Emanuel Bach',
    credit: 'Arranged by a Very Long Channel Name Indeed',
    small: 'Dedicated to everyone who listens to the very end',
  },
  word: { title: 'Pneumonoultramicroscopicsilicovolcanoconiosis', subtitle: '', composer: 'Supercalifragilisticexpialidociousness', credit: '', small: '' },
  cjk: { title: '月の光とピアノのための小さな組曲と夜の歌', subtitle: 'ベルガマスク組曲', composer: 'ドビュッシー', credit: 'Piano2Vision', small: '' },
};
const SIZES: [number, number][] = [
  [1920, 1080],
  [1280, 720],
  [1080, 1920],
  [1440, 2560],
  [1080, 1080],
];

const inside = (r: Rect, s: Rect, tol = 0.5) => r.x0 >= s.x0 - tol && r.y0 >= s.y0 - tol && r.x1 <= s.x1 + tol && r.y1 <= s.y1 + tol;

function checkLayout(L: TitleLayout, text: TitleText, label: string) {
  let prev = -Infinity;
  for (const b of L.blocks) {
    expect(inside(b.box, L.safe), `${label}: ${b.role} box inside safe area`).toBe(true);
    for (const d of b.divider?.boxes ?? []) expect(inside(d, L.safe), `${label}: ${b.role} divider inside safe area`).toBe(true);
    expect(b.box.y0, `${label}: ${b.role} below the block above`).toBeGreaterThanOrEqual(prev - 0.5);
    prev = b.box.y1;
    for (const w of b.lineWidths) expect(w, `${label}: ${b.role} line fits`).toBeLessThanOrEqual(L.safe.x1 - L.safe.x0 + 0.5);
    const maxLines = b.role === 'title' ? (L.portrait ? 4 : 3) : 2;
    if (b.role !== 'ornament') expect(b.lines.length, `${label}: ${b.role} max lines`).toBeLessThanOrEqual(maxLines);
  }
  const roles = L.blocks.map((b) => b.role).filter((r) => r !== 'ornament');
  const order = ['title', 'subtitle', 'composer', 'credit', 'small'];
  expect(roles, `${label}: order`).toEqual(order.filter((r) => text[r as keyof TitleText].trim()));
}

describe('title page layout', () => {
  for (const p of TITLE_PRESETS)
    for (const [W, H] of SIZES)
      for (const [name, text] of Object.entries(TEXTS)) {
        it(`${p.id} ${W}×${H} ${name}: inside the safe area, in order, no overlap`, () => {
          const L = layoutTitleCard(W, H, resolveLook({ ...DEFAULT_LOOK, preset: p.id }), text, fake);
          checkLayout(L, text, `${p.id} ${W}x${H} ${name}`);
        });
      }

  it('random combinations of empty fields: empty fields make no block, the rest stays valid', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 300; i++) {
      const src = Object.values(TEXTS)[i % 4];
      const text = { ...src };
      for (const k of Object.keys(text) as (keyof TitleText)[]) if (rnd() < 0.45) text[k] = '';
      const p = TITLE_PRESETS[i % TITLE_PRESETS.length];
      const [W, H] = SIZES[i % SIZES.length];
      const look: TitleLook = { ...DEFAULT_LOOK, preset: p.id, divider: (['none', 'rules', 'diamond', 'vine', 'scroll'] as const)[i % 5] };
      const L = layoutTitleCard(W, H, resolveLook(look), text, fake);
      checkLayout(L, text, `combo ${i}`);
    }
  });

  it('a title-only card is centred (horizontally exactly, vertically within 1 px of the optical centre)', () => {
    const text = { ...TEXTS.short, subtitle: '', composer: '', credit: '', small: '' };
    for (const [W, H] of SIZES) {
      const L = layoutTitleCard(W, H, resolveLook({ ...DEFAULT_LOOK, preset: 'classic' }), text, fake);
      const b = L.blocks[0];
      expect(Math.abs((b.box.x0 + b.box.x1) / 2 - W / 2)).toBeLessThan(0.01);
      const mid = (L.safe.y0 + L.safe.y1) / 2 - (L.portrait ? 0 : 0.01 * H);
      expect(Math.abs((b.box.y0 + b.box.y1) / 2 - mid)).toBeLessThan(1);
    }
  });

  // (wrapping onto one more line may bring the full size back, which is wanted: a slightly smaller
  // single line is preferred over two lines until it would shrink below 82 %)
  it('with the same number of lines, a longer title never gets bigger letters', () => {
    const words = 'Moonlight Sonata Variations For The Long Winter Evenings By The Fire'.split(' ');
    for (const p of TITLE_PRESETS)
      for (const [W, H] of SIZES) {
        const last = new Map<number, number>();
        for (let n = 1; n <= words.length; n++) {
          const L = layoutTitleCard(W, H, resolveLook({ ...DEFAULT_LOOK, preset: p.id }), { ...TEXTS.short, title: words.slice(0, n).join(' ') }, fake);
          const { px, lines } = L.blocks[0];
          expect(px, `${p.id} ${W}x${H} ${n} words`).toBeLessThanOrEqual((last.get(lines.length) ?? Infinity) + 1e-6);
          last.set(lines.length, px);
          expect(px, 'never larger than the design size').toBeLessThanOrEqual(p.lines.title.size * L.B + 1e-6);
        }
      }
  });

  it('a short composer fits beside its dividers; a long one gets them below', () => {
    const look = resolveLook({ ...DEFAULT_LOOK, preset: 'floral' });
    const short = layoutTitleCard(1920, 1080, look, TEXTS.short, fake).blocks.find((b) => b.role === 'composer')!;
    expect(short.divider?.mode).toBe('side');
    const long = layoutTitleCard(1080, 1920, look, TEXTS.long, fake).blocks.find((b) => b.role === 'composer')!;
    expect(long.divider?.mode).toBe('below');
  });

  it('a flourish with no composer becomes one ornament between the main lines and the footer', () => {
    const L = layoutTitleCard(1920, 1080, resolveLook({ ...DEFAULT_LOOK, preset: 'floral' }), { ...TEXTS.short, composer: '' }, fake);
    expect(L.blocks.map((b) => b.role)).toEqual(['title', 'subtitle', 'ornament', 'credit', 'small']);
  });

  it('caseless text is not uppercased and is broken into balanced pieces', () => {
    const L = layoutTitleCard(1080, 1920, resolveLook({ ...DEFAULT_LOOK, preset: 'classic' }), TEXTS.cjk, fake);
    const t = L.blocks[0];
    expect(t.lines.join('')).toBe(TEXTS.cjk.title);
    expect(t.lines.length).toBeGreaterThan(1);
    expect(layoutTitleCard(1920, 1080, resolveLook({ ...DEFAULT_LOOK, preset: 'classic' }), TEXTS.short, fake).blocks[0].lines[0]).toBe('CLAIR DE LUNE');
  });

  it('a Latin word is never broken between letters; only an extremely long one is hyphenated', () => {
    for (const p of TITLE_PRESETS)
      for (const [W, H] of SIZES)
        for (const word of ['Nocturne', 'Arabesque', 'Gymnopédie', 'Hallelujah', 'Interstellar', 'Liebestraum', 'Rachmaninoff']) {
          const L = layoutTitleCard(W, H, resolveLook({ ...DEFAULT_LOOK, preset: p.id }), { ...TEXTS.short, title: word, composer: word }, fake);
          for (const b of L.blocks.filter((x) => x.role === 'title' || x.role === 'composer')) expect(b.lines, `${p.id} ${W}x${H} ${word} ${b.role}`).toHaveLength(1);
        }
    const L = layoutTitleCard(1080, 1920, resolveLook({ ...DEFAULT_LOOK, preset: 'classic' }), TEXTS.word, fake);
    const t = L.blocks[0];
    if (t.lines.length > 1) {
      t.lines.slice(0, -1).forEach((l) => expect(l.endsWith('-')).toBe(true));
      expect(t.lines.map((l) => l.replace(/-$/, '')).join('')).toBe(TEXTS.word.title.toUpperCase());
    }
  });

  it('a short title stays on one line in landscape (Waltz of the Flowers)', () => {
    for (const p of TITLE_PRESETS.filter((x) => x.lines.title.upper)) {
      const L = layoutTitleCard(1920, 1080, resolveLook({ ...DEFAULT_LOOK, preset: p.id }), { ...TEXTS.short, title: 'Waltz of the Flowers' }, fake);
      expect(L.blocks[0].lines, p.id).toEqual(['WALTZ OF THE FLOWERS']);
    }
  });

  it('hierarchy: the credit stays narrower than the title, the other lines smaller than its capitals', () => {
    const text = { title: 'Nocturne', subtitle: 'Op. 9 No. 2', composer: 'Sergei Rachmaninoff', credit: 'Arranged by Lumen Keys', small: 'Dedicated to everyone' };
    for (const p of TITLE_PRESETS)
      for (const [W, H] of SIZES)
        for (const t of [text, TEXTS.long]) {
          const L = layoutTitleCard(W, H, resolveLook({ ...DEFAULT_LOOK, preset: p.id }), t, fake);
          const title = L.blocks.find((b) => b.role === 'title')!;
          const safeW = L.safe.x1 - L.safe.x0;
          for (const b of L.blocks) {
            if (b.role === 'credit' || b.role === 'small') expect(b.textW, `${p.id} ${W}x${H} ${b.role} width`).toBeLessThanOrEqual(Math.max(0.7 * title.textW, 0.5 * safeW) + 0.5);
            if (b.role === 'composer') expect(b.cap, `${p.id} ${W}x${H} composer cap`).toBeLessThanOrEqual(0.75 * title.cap + 1e-6);
            if (b.role === 'credit' || b.role === 'small' || b.role === 'subtitle') expect(b.cap).toBeLessThan(title.cap);
          }
        }
  });

  it('caseless text with a space breaks at the space', () => {
    const L = layoutTitleCard(1080, 1920, resolveLook({ ...DEFAULT_LOOK, preset: 'floral' }), { ...TEXTS.short, title: '千と千尋の神隠し いつも何度でも' }, fake);
    expect(L.blocks[0].lines).toEqual(['千と千尋の神隠し', 'いつも何度でも']);
  });

  it('a centred flourish pair spans its box exactly (nothing is clipped)', () => {
    for (const divider of ['vine', 'scroll'] as const) {
      const L = layoutTitleCard(1080, 1920, resolveLook({ ...DEFAULT_LOOK, preset: 'ornate', divider }), TEXTS.long, fake);
      const d = L.blocks.find((b) => b.role === 'composer')!.divider!;
      expect(d.mode).toBe('below');
      const box = d.boxes[0];
      expect(box.x1 - box.x0).toBeCloseTo(2 * d.len, 6);
      // the drawn pair: inner ends BELOW_GAP em from the centre, each ornament as wide as its bounds
      const f = FLOURISH_BOUNDS[divider];
      expect(d.len).toBeCloseTo((BELOW_GAP + f.maxX - f.minX) * d.em, 6);
    }
  });

  it('light backgrounds get dark text (unless the user picked a colour), no vignette over the user colour', () => {
    const light = resolveLook({ ...DEFAULT_LOOK, preset: 'classic', bg: 'color', bgColor: '#f3eee4' });
    expect(hexLuminance(light.lines.title.color)).toBeLessThan(0.05);
    expect(hexLuminance(light.lines.credit.color)).toBeLessThan(0.1);
    expect(light.styleBg).toBe(false);
    const own = resolveLook({ ...DEFAULT_LOOK, preset: 'classic', bg: 'color', bgColor: '#f3eee4', textColor: '#aa0000' });
    expect(own.lines.title.color).toBe('#aa0000');
    const dark = resolveLook({ ...DEFAULT_LOOK, preset: 'classic', bg: 'color', bgColor: '#101018' });
    expect(dark.lines.title.color).toBe(resolveLook({ ...DEFAULT_LOOK, preset: 'classic' }).lines.title.color);
    expect(resolveLook({ ...DEFAULT_LOOK, preset: 'floral' }).styleBg).toBe(true);
    // a busy picture: light text with a dark scrim when it is mostly dark, dark text when mostly light
    const base = resolveLook({ ...DEFAULT_LOOK, preset: 'classic' });
    const onDark = adaptLook(base, 0, { median: 0.05, lo: 0.01, hi: 0.6 });
    expect(onDark.lines.title.color).toBe(base.lines.title.color);
    expect(onDark.scrim?.rgb).toBe('0,0,0');
    expect(onDark.textHalo).not.toBeNull();
    expect(hexLuminance(adaptLook(base, 0, { median: 0.6, lo: 0.1, hi: 0.9 }).lines.title.color)).toBeLessThan(0.05);
  });

  it('the script title keeps its case', () => {
    const L = layoutTitleCard(1920, 1080, resolveLook({ ...DEFAULT_LOOK, preset: 'script' }), TEXTS.short, fake);
    expect(L.blocks[0].lines[0]).toBe('Clair de Lune');
  });
});

describe('balanced line breaks', () => {
  const brute = (w: number[], n: number, j: number) => {
    let best = Infinity;
    const rec = (start: number, k: number, widest: number) => {
      if (k === 1) {
        const lw = w.slice(start).reduce((a, b) => a + b, 0) + (w.length - start - 1) * j;
        best = Math.min(best, Math.max(widest, lw));
        return;
      }
      for (let i = start + 1; i <= w.length - (k - 1); i++) rec(i, k - 1, Math.max(widest, w.slice(start, i).reduce((a, b) => a + b, 0) + (i - start - 1) * j));
    };
    rec(0, Math.min(n, w.length), 0);
    return best;
  };
  it('is optimal on small cases (checked against brute force)', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let c = 0; c < 400; c++) {
      const T = 1 + Math.floor(rnd() * 9);
      const w = Array.from({ length: T }, () => 1 + Math.floor(rnd() * 20));
      const n = 1 + Math.floor(rnd() * 4);
      const j = Math.floor(rnd() * 4);
      const starts = balancedBreaks(w, n, j);
      const widest = Math.max(
        ...starts.map((s, i) => {
          const e = starts[i + 1] ?? T;
          return w.slice(s, e).reduce((a, b) => a + b, 0) + (e - s - 1) * j;
        }),
      );
      expect(widest).toBe(brute(w, n, j));
      expect(starts[0]).toBe(0);
    }
  });
});

describe('title page timeline', () => {
  it('the title length is whole frames and whole 48 kHz samples', () => {
    for (const fps of [30, 60])
      for (let d = 2; d <= 10; d += 0.5) {
        const tl = cardTimeline(fps, d, d);
        expect(tl.introFrames).toBe(Math.round(d * fps));
        expect(Number.isInteger(Math.round(tl.intro * 48000 * 1e6) / 1e6)).toBe(true);
        expect(Math.abs(tl.intro * 48000 - Math.round(tl.intro * 48000))).toBeLessThan(1e-6);
        expect(totalSeconds(tl, 600)).toBeCloseTo(tl.intro + 600 / fps + tl.outro, 9);
      }
    expect(cardTimeline(60, 0, 0)).toMatchObject({ intro: 0, outro: 0, introFrames: 0, outroFrames: 0 });
  });

  it('crossfade and end card fades', () => {
    expect(titleOpacity(0, 4)).toBe(1);
    expect(titleOpacity(3.0, 4)).toBeCloseTo(1, 9);
    expect(titleOpacity(3.5, 4)).toBeCloseTo(0.5, 9);
    expect(titleOpacity(4, 4)).toBe(0);
    expect(endOpacity(0, 4)).toBe(0);
    expect(endOpacity(0.3, 4)).toBeCloseTo(0.5, 9);
    expect(endOpacity(2, 4)).toBe(1);
    expect(endOpacity(3.6, 4)).toBeCloseTo(0.5, 9);
  });

  it('roll frames are moved by exactly the title length, after the title frames', async () => {
    const fps = 30;
    const tl = cardTimeline(fps, 2.5, 0);
    const added: number[] = [];
    let titleFrames = 0;
    const track = { add: async (t: number) => void added.push(t) };
    const v = shiftVideo(track, tl.intro, async () => {
      for (let i = 0; i < tl.introFrames; i++) await track.add(i / fps);
      titleFrames = tl.introFrames;
    });
    for (let i = 0; i < 90; i++) await v.add(i / fps, 1 / fps);
    expect(titleFrames).toBe(75);
    expect(added.length).toBe(75 + 90);
    // frame N of the roll lands exactly where frame N + 75 is: same picture as frame N without a title
    for (let i = 0; i < 90; i++) expect(added[75 + i]).toBeCloseTo((i + 75) / fps, 12);
    for (let i = 1; i < added.length; i++) expect(added[i]).toBeGreaterThan(added[i - 1]);
  });

  it('audio: silence first, samples moved by the title length, silence up to the end', async () => {
    class S {
      constructor(
        public timestamp: number,
        public duration: number,
        public silent = false,
      ) {}
      setTimestamp(t: number) {
        this.timestamp = t;
      }
    }
    const got: S[] = [];
    const a = shiftAudio<S>({ add: async (s) => void got.push(s) }, 2.5, (t, d) => new S(t, d, true));
    await a.add(new S(0, 2)); // lead-in
    await a.add(new S(2, 45));
    await a.add(new S(47, 3.25));
    await a.finish(2.5 + 50.25 + 3);
    const silence = got.filter((s) => s.silent);
    expect(silence[0].timestamp).toBe(0);
    expect(got.filter((s) => !s.silent).map((s) => s.timestamp)).toEqual([2.5, 4.5, 49.5]);
    // contiguous from 0 to the end of the end card
    let t = 0;
    for (const s of got) {
      expect(s.timestamp).toBeCloseTo(t, 9);
      t = s.timestamp + s.duration;
    }
    expect(t).toBeCloseTo(55.75, 9);
    expect(Math.max(...silence.map((s) => s.duration))).toBeLessThanOrEqual(1);
  });

  it('without a title the audio is untouched', async () => {
    const got: number[] = [];
    const a = shiftAudio<{ timestamp: number; duration: number; setTimestamp(t: number): void }>({ add: async (s) => void got.push(s.timestamp) }, 0, () => {
      throw new Error('no silence expected');
    });
    await a.add({ timestamp: 0, duration: 1, setTimestamp: () => {} });
    await a.add({ timestamp: 1, duration: 1, setTimestamp: () => {} });
    expect(got).toEqual([0, 1]);
  });
});

describe('title page settings', () => {
  it('sanitize: missing, garbage and partial values give valid defaults', () => {
    for (const raw of [undefined, null, 42, 'x', [], { look: 'nope', duration: 'long', songs: 5, end: [] }]) {
      const s = sanitizeTitleCard(raw);
      expect(s).toEqual(DEFAULT_TITLE_CARD);
    }
    const s = sanitizeTitleCard({
      enabled: true,
      duration: 37,
      look: { preset: 'disco', font: 'comic', fill: 'pattern', pattern: 'bouquet', fillColor: 'red', textColor: '#ABCDEF', dim: 3, gradient: ['#000000', 'blue'], extra: 1 },
      remembered: { credit: 'Me', small: 7 },
      end: { enabled: true, duration: 0.3, main: 'Bye', credit: 'X' },
    });
    expect(s.enabled).toBe(true);
    expect(s.duration).toBe(10);
    expect(s.look.preset).toBe(DEFAULT_LOOK.preset);
    expect(s.look.font).toBeNull();
    expect(s.look.fill).toBe('pattern');
    expect(s.look.fillColor).toBeNull();
    expect(s.look.textColor).toBe('#abcdef');
    expect(s.look.dim).toBe(0.8);
    expect(s.look.gradient).toBeNull();
    expect('extra' in s.look).toBe(false);
    expect(s.remembered).toEqual({ credit: 'Me', small: '' });
    expect(s.end).toEqual({ enabled: true, duration: 2, main: 'Bye', credit: 'X', small: '' });
  });

  it('durations are 2..10 s in 0.5 s steps', () => {
    expect(clampDuration(4.3)).toBe(4.5);
    expect(clampDuration(1)).toBe(2);
    expect(clampDuration(99)).toBe(10);
    expect(clampDuration(NaN)).toBe(4);
  });

  it('keeps only the 30 most recently changed songs', () => {
    const songs = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, { text: { title: `T${i}` }, at: i }]));
    const kept = trimSongs(songs);
    expect(Object.keys(kept).length).toBe(30);
    expect(kept.s39).toBeTruthy();
    expect(kept.s9).toBeUndefined();
    expect(Object.keys(sanitizeTitleCard({ songs }).songs).length).toBe(30);
  });

  it('text for a song: defaults from the song, "Composer - Title" split, the user changes on top', () => {
    const rem = { credit: 'My Channel', small: 'For you' };
    expect(defaultTextForSong({ title: 'Chopin - Ballade No. 1' }, rem)).toEqual({ title: 'Ballade No. 1', subtitle: '', composer: 'Chopin', credit: 'My Channel', small: 'For you' });
    expect(defaultTextForSong({ title: 'Nocturne – Op. 9', artist: 'Chopin' }, rem).title).toBe('Nocturne – Op. 9');
    expect(defaultTextForSong({ title: 'Clair de Lune' }, rem).composer).toBe('');
    expect(splitTitle('Re-Animator')).toBeNull();
    const s = { ...DEFAULT_TITLE_CARD, remembered: rem, songs: { a: { text: { subtitle: 'Op. 23', credit: '' }, at: 1 } } };
    expect(textForSong({ id: 'a', title: 'Ballade' }, s)).toMatchObject({ title: 'Ballade', subtitle: 'Op. 23', credit: '' });
    expect(textForSong({ id: 'b', title: 'Ballade' }, s).credit).toBe('My Channel');
  });

  it('end card text: main line, then the title page credit unless it has its own', () => {
    const t = { title: 'X', subtitle: 'Y', composer: 'Z', credit: 'C', small: 'S' };
    expect(endCardText({ ...DEFAULT_TITLE_CARD.end }, t)).toEqual({ title: 'Thank you for listening', subtitle: '', composer: '', credit: 'C', small: '' });
    expect(endCardText({ ...DEFAULT_TITLE_CARD.end, credit: '' }, t).credit).toBe('');
  });

  it('resolving looks: tweaks override the style, presets stay distinct', () => {
    const base = resolveLook({ ...DEFAULT_LOOK, preset: 'classic' });
    expect(base.fill.kind).toBe('solid');
    const r = resolveLook({ ...DEFAULT_LOOK, preset: 'classic', fill: 'pattern', pattern: 'galaxy', fillScope: 'all', font: 'script', divider: 'vine' });
    expect(r.fill).toEqual({ kind: 'pattern', id: 'galaxy' });
    expect(r.fillRoles).toEqual(['title', 'subtitle', 'composer']);
    expect(r.lines.title.font).toBe('vibes');
    expect(r.lines.title.upper).toBe(false);
    expect(r.divider).toBe('vine');
    // an image fill with no image falls back to the style's own fill
    expect(resolveLook({ ...DEFAULT_LOOK, preset: 'floral', fill: 'image' }).fill).toEqual({ kind: 'pattern', id: 'bouquet' });
    // old-style digits are drawn in Cinzel on Playfair caps lines
    expect(resolveLook({ ...DEFAULT_LOOK, preset: 'classic' }).lines.title.digits).toBe('cinzel');
    expect(new Set(TITLE_PRESETS.map((p) => JSON.stringify([p.lines.title.font, p.fill, p.divider, p.bg]))).size).toBe(TITLE_PRESETS.length);
  });
});

describe('saved settings stay compatible', () => {
  it('old pianovision-settings load unchanged and the title store starts at its defaults', async () => {
    const store = new Map<string, string>();
    const oldExport = { resolution: 720, fps: 30, format: 'webm', orientation: 'portrait', range: 'full', customStart: 0, customEnd: 30, rate: 0.75, volume: 1, fadeIn: 0.5, fadeOut: 2, showKeyboard: true, leadIn: 2, quality: 'high', keyboardRange: 'match' };
    store.set('pianovision-settings', JSON.stringify({ state: { exportSettings: oldExport, exportPresets: [{ id: 'p', name: 'mine', settings: oldExport }] }, version: 1 }));
    const localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    Object.assign(globalThis, { window: { localStorage }, localStorage });
    const { useSettings } = await import('../../src/state/settingsStore');
    const { useTitleCard, TITLE_CARD_STORAGE_KEY, flushTitleCardStorage } = await import('../../src/state/titleCardStore');
    expect(useSettings.getState().exportSettings).toMatchObject(oldExport);
    expect(useSettings.getState().exportPresets[0].name).toBe('mine');
    expect(useTitleCard.getState().enabled).toBe(false);
    expect(useTitleCard.getState().look).toEqual(DEFAULT_LOOK);
    useTitleCard.getState().setEnabled(true);
    useTitleCard.getState().setSongText('song1', { credit: 'My Channel' });
    // writes are batched (not on every key press), then flushed
    expect(store.get(TITLE_CARD_STORAGE_KEY)).toBeUndefined();
    flushTitleCardStorage();
    const saved = JSON.parse(store.get(TITLE_CARD_STORAGE_KEY)!);
    expect(saved.state.enabled).toBe(true);
    expect(saved.state.remembered.credit).toBe('My Channel');
    expect(JSON.parse(store.get('pianovision-settings')!).state.exportSettings).toMatchObject(oldExport);
    useTitleCard.getState().applyPreset('gala');
    expect(useTitleCard.getState().look).toEqual({ ...DEFAULT_LOOK, preset: 'gala' });
  });
});
