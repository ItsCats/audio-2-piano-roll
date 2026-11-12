# Video export

Studio → **Export Video** renders the piano roll itself — not a screen recording — into an MP4 or WebM file with synchronised piano audio. No navigation, panels or cursor are captured.

## Pipeline (`src/lib/export/videoExport.ts`)

1. **Codec selection** (mediabunny): MP4 tries H.264 → HEVC → VP9 → AV1; WebM tries VP9 → VP8 → AV1. Audio is AAC for MP4 (native WebCodecs, or a lazily loaded WASM AAC encoder when the browser has none) and Opus for WebM.
2. **Audio**: the arrangement is rendered offline by the same `PianoEngine` used live, in 45-second chunks with an 18-second pre-roll so ringing notes and reverb tails carry across chunk boundaries, then encoded. Lead-in silence, export volume and fade-in/out are applied sample-accurately.
3. **Video**: an `OffscreenCanvas` at the target resolution is drawn by the same `PianoRollRenderer` as the Studio, including note decals (patterns or the user's uploaded image), falling-note glow, light bursts, sparkle dust and key light. Frame *i* shows song time `start + (i/fps − leadIn) × speed`, so audio and video are locked by construction. Effects (glow, sparks, trails) are pure functions of time, so every frame is deterministic.
4. **Background video** frames are decoded with mediabunny's `CanvasSink.canvasesAtTimestamps` for exactly the (looped) timestamps needed — no real-time playback involved.
5. **Muxing** streams into a file in the **Origin Private File System** when available (bounded memory for long exports), otherwise into memory. MP4s written to memory use fast-start.
6. **Preview & download**: the finished video plays in the dialog; *Download* saves it.

Progress shown is real: audio-render fraction, then encoded frames / total, render speed (fps) and ETA.

## Options

| Option | Values |
| --- | --- |
| Resolution | 720p, 1080p, 1440p (by orientation: 1280×720, 1920×1080, 2560×1440 / 1080×1920 / 1080×1080 …) |
| Frame rate | 30, 60 |
| Container | MP4 (default), WebM |
| Orientation | 16:9, 9:16, 1:1 |
| Content | full song (leading silence trimmed), A–B loop, custom range |
| Speed / volume | 0.5–1.5× / 20–150 % |
| Lead-in, fade-in, fade-out | seconds |
| Keyboard | show/hide; range same as Studio, fit-to-song, or 88 keys (9:16 automatically fits to the song) |
| Look | everything from the Studio's Look and Labels tabs, a theme picker and a labels toggle |
| Presets | **YouTube Ready** (16:9, 1080p, 60 fps, MP4), Shorts/Reels/TikTok (9:16 1080×1920 60 fps, fitted keyboard), Instagram Square (1:1), Quick Preview (720p30); save your own |

## Measured results

Headless Chromium, 4-core VM, no GPU:

* 12 s, 1280×720, 30 fps, MP4: rendered in **5.4 s** (2.2× real time), H.264 + AAC, 360 frames, 48 kHz stereo.
* A/V sync: the first note reaches the hit line in frame 60 (t = 2.000 s with a 2 s lead-in) and the audio's first sample is at 2.011 s — within the ±20 ms perceptual threshold (residual is the AAC codec's pre-echo/attack ramp).
* Production build under the site's Content-Security-Policy: 34 s 720p MP4 exported successfully.

Measured with the Blossom look (decals, glow, bursts, dust, key light, realistic keyboard): a 10 s 1920×1080 60 fps MP4 rendered in 14 s in headless Chromium without a GPU. `tests/e2e/determinism.html` checks that frames are pixel-identical across fresh renderers and after seeking (exports always use a fresh renderer).

## Fallback

Without WebCodecs (old Safari/Firefox), the export renders in real time to a canvas and records it with `MediaRecorder` together with the live engine's audio (WebM). It takes as long as the music and frame pacing depends on the device.

## Tips

* 1080p60 of a 4-minute song is ~14 400 frames; expect roughly 1–3× real time on a laptop with hardware encoding.
* If MP4 shows a non-H.264 codec badge, the browser lacks an H.264 encoder (some Linux builds); the file still plays in browsers, VLC and on YouTube.

## Title page and end card

Optional, off by default, videos only (the Studio is unchanged). In the dialog: **Title page** → "Add a title page", then a style (Classic, Gold, Floral, Romance, Modern, Gala), the lines (title, subtitle, composer or artist, credit, small line; an empty line is not drawn), **Customize** (font, letters: colour / gradient / pattern / your own image, which lines use it, divider, background incl. "Same as video" or your own image with dimming, streaks, sparkles, slow zoom, shine) and the length (2–10 s, default 4 s). **End card** works the same way at the end ("Thank you for listening", credit, small line). The live preview has the output's aspect ratio and a Play button. Text defaults come from the song (a "Composer – Title" song name is split); the credit and small line are remembered for new songs. Settings are saved under their own key, `piano2vision-title-card`, so older saved settings and export presets load unchanged. Layout rules: a Latin word is never split between letters (it is tightened and shrunk; only an extremely long word is hyphenated), short titles stay on one line in landscape, and the other lines never outgrow the title. On a light colour or picture the text turns dark unless you picked a colour; on a picture every line gets a soft halo and a soft scrim behind the text, and a photo inside the letters is brightened so it stays readable.

* **Code.** `src/lib/render/titleCard/` (pure layout, styles, drawing, procedural flower pattern and ornaments, timeline, font loading) and `src/components/studio/TitleCardPanel.tsx`. The export integration is small: `prepareTitleCards()` wraps the export's audio and video tracks.
* **Timing.** The title page is silent; the piano roll, with its own lead-in, starts after it, and every roll frame and audio sample is moved by the title's length (rounded to whole frames, which at 30/60 fps is also a whole number of 48 kHz samples), so sync after the title is exact. Over the title page's last second its text fades into its own background, then the first roll frame fades in (no double exposure; the picture fade-in is skipped then; the music's own fade-in still applies). The end card follows the roll's fade-out, fades in from black and out to black, with silence.
* **Layout.** Sizes come from the output size (16:9, 9:16 with room for the Shorts/Reels UI, 1:1). Long lines are balanced over up to 3 lines (4 for a portrait title), then the letter spacing is tightened and the text shrunk, so nothing is cut off. Letters are placed one by one (no Canvas `letterSpacing`, `ctx.filter` or font features are needed, so it also works in Safari and on `OffscreenCanvas`).
* **Fonts.** Cinzel, Playfair Display, Cormorant Garamond, EB Garamond and Great Vibes (SIL OFL, self-hosted, see Credits) plus the app's Inter. They are fetched only when a title page is previewed or exported, and the export waits for them (at most 8 s; if one fails, a standard font is used and the dialog says so).
* **Your images** stay on the device (IndexedDB), are downscaled when added (at most 1600 px for letters, 2048 px for backgrounds) and are never uploaded.
* **Checks.** `tests/unit/titleCard.test.ts`; `node tests/e2e/title-card.mjs` (every style × 16:9 / 9:16 / 1:1 × normal, long, CJK and one-long-word texts with the real fonts: fonts loaded, boxes and ink inside the safe area, measured widths match the ink); `node tests/e2e/title-export.mjs` (with a 2.5 s title page the first note is heard exactly 2.5 s later, roll frame N matches frame N + 75, lengths, a silent end card); `node tests/e2e/title-card-ui.mjs --dist DIR --out DIR` (the dialog on desktop and a 390 px phone against a production build with the site's headers).
* **Note for merging the original-song option.** It must use the same moved timeline: with the wrapped tracks nothing else changes, because the original-song mix is added to the same audio samples before they reach the wrapper.
