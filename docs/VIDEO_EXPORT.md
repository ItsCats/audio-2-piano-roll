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
