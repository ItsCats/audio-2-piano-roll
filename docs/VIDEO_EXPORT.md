# Video export

Studio → **Export Video** renders the piano roll itself — not a screen recording — into an MP4 or WebM file with synchronised piano audio. No navigation, panels or cursor are captured.

## Pipeline (`src/lib/export/videoExport.ts`)

1. **Codec selection** (mediabunny): MP4 tries H.264 → HEVC → VP9 → AV1; WebM tries VP9 → VP8 → AV1. Audio is AAC for MP4 (native WebCodecs, or a lazily loaded WASM AAC encoder when the browser has none) and Opus for WebM.
2. **Audio**: the arrangement is rendered offline by the same `PianoEngine` used live, in 45-second chunks with an 18-second pre-roll so ringing notes and reverb tails carry across chunk boundaries, then encoded. Lead-in silence, export volume and fade-in/out are applied sample-accurately; the fades are measured on the video's timeline (from the start of the file, lead-in included), so the sound fades exactly with the picture.
3. **Video**: an `OffscreenCanvas` at the target resolution is drawn by the same `PianoRollRenderer` as the Studio, including note decals (patterns or the user's uploaded image), falling-note glow, light bursts, sparkle dust and key light. Frame *i* shows song time `start + (i/fps − leadIn) × speed`, so audio and video are locked by construction. Effects (glow, sparks, trails) are pure functions of time, so every frame is deterministic.
4. **Background video** frames are decoded with mediabunny's `CanvasSink.canvasesAtTimestamps` for exactly the (looped) timestamps needed — no real-time playback involved.
5. **Muxing** streams into a file in the **Origin Private File System** when available (bounded memory for long exports), otherwise into memory. MP4s written to memory use fast-start.
6. **Preview & download**: the finished video plays in the dialog; *Download* saves it.

Progress shown is real: audio-render fraction, then encoded frames / total, render speed (fps) and ETA.

## Sound: piano, original song or both

Songs imported from audio keep their original recording. The dialog's **Sound** choice puts the app's piano, the original recording, or both into the video (default: piano). It is hidden, with a short reason, when the song has no saved recording (MIDI files, the demo, YouTube imports without a stored recording) or when the browser has no WebCodecs (the real-time fallback records the piano only). Code: `src/lib/export/originalMix.ts` (pure, unit-tested) and `exportVideo`.

* **Sync rule.** At video time *o* the picture shows song time `start + (o − leadIn)`, and the original plays that same song time. Recording time 0 is song time 0, the timebase the transcription used (`decodeToRate`, native `decodeAudioData`). So the lead-in plays the recording from just before the start (for a custom or loop range, what comes before it is heard); only lead-in time before song time 0 is silent, as is anything past the end of the recording. With the original included, **Full song** starts at song time 0 rather than just before the first note, so a long intro before the first transcribed note is kept (the lead-in is then silence). At 48 kHz this is a whole-sample offset: output frame *k* plays recording frame `k − round(leadIn·48000) + round(start·48000)`. The piano render already removes the engine's 12 ms latency, so no extra delay is needed.
* **Mixing.** The recording is decoded once at 48 kHz (the browser resamples) and added sample by sample into the lead-in block and each 45 s piano chunk; for "Original song" only, the piano is not rendered. Piano volume and original volume are separate. When the original is included a peak limiter keeps the mix at or below 0.89 (about −1 dB, room for the AAC/Opus encoder's own overshoot): it looks 5 ms ahead and turns the gain down smoothly before a peak, recovers over ~150 ms, uses the same gain on both channels and adds no delay (it runs offline on each block, carrying its gain across blocks). Quieter mixes pass untouched; piano-only output is not limited. The original follows the picture's fade-in/out and keeps playing under the fade-out tail; with no fade-out it still ramps down over the last 0.3 s so the file doesn't end in a click.
* **Speed.** With the original included, export speed is fixed at 100 % (the slider is disabled with a note). Changing speed without changing pitch needs a time-stretcher: changing the playback rate would put the recording out of tune with the piano, the permissively licensed option (Signalsmith Stretch, MIT) would add a WASM/worklet module, latency compensation and chunk continuity work, and a full band mix stretched to 0.5–0.75× sounds smeared. It may be added later.
* **Memory.** The recording is decoded only when the export starts and only if it is used, and released before any video frame is drawn. Decoding holds the whole song as 32-bit samples at 48 kHz: ~115 MB for 5 minutes of stereo, ~460 MB at the 20-minute import limit, plus the compressed file while it decodes. That is the peak; nothing is copied after it. The export keeps views into the decoded channels for the part it can hear (range ± lead-in and tail); only a span of up to 60 s (a loop or short custom range) is copied out, so the rest can be freed. On phones and low-memory devices songs over 4 minutes (and any file with more than two channels) are downmixed to mono in place, which halves what is kept during the sound render (~58 MB for 5 minutes) but not the decode peak. If decoding fails, the dialog says so and suggests "Piano".
* **Encoder stalls.** The WASM AAC encoder (used for MP4 where the browser has no AAC encoder: Firefox, Linux Chrome, headless Chromium) could hang forever on some near-silent "Both" mixes. Samples smaller than 10⁻⁶ (about −120 dB, inaudible) are set to 0 before AAC encoding, which avoids it. As a safety net every encoder step has a time limit (2 minutes per audio block or frame; one minute plus 6 s per minute of video to write the end of the file) and Cancel works at every step: a stuck export stops with "Saving the video got stuck…", suggesting WebM, and the encoder's worker is stopped. A cancelled export that is still decoding the original can't be interrupted, so **Render video** shows "Stopping…" until it has finished, and two exports never run at once.
* **Check.** `npm run test:e2e:export` exports a synthetic song whose "recording" is a click on every note (MP4 and WebM, full range, a custom range starting mid-song, Piano + Original including 40 s MP4s and a loud mix with both sliders at 150 %), decodes the files with ffmpeg and checks every click is within 10 ms of its note, the file doesn’t clip at normal levels, nothing above the limiter's level reaches the encoder, and every case finishes.

## Options

| Option | Values |
| --- | --- |
| Resolution | 720p, 1080p, 1440p (by orientation: 1280×720, 1920×1080, 2560×1440 / 1080×1920 / 1080×1080 …) |
| Frame rate | 30, 60 |
| Container | MP4 (default), WebM |
| Orientation | 16:9, 9:16, 1:1 |
| Content | full song (leading silence trimmed; from the very start when the original is included), A–B loop, custom range |
| Sound | Piano (default), Original song, Both; original-song volume 5–150 % (starts at the Studio's "Original" level, or 80 %) |
| Speed / volume | 0.5–1.5× (100 % when the original is included) / 20–150 % |
| Lead-in, fade-in, fade-out | seconds |
| Keyboard | show/hide; range same as Studio, fit-to-song, or 88 keys (9:16 automatically fits to the song) |
| Look | everything from the Studio's Look and Labels tabs, a theme picker and a labels toggle |
| Presets | **YouTube Ready** (16:9, 1080p, 60 fps, MP4), Shorts/Reels/TikTok (9:16 1080×1920 60 fps, fitted keyboard), Instagram Square (1:1), Quick Preview (720p30); save your own |

## Measured results

Headless Chromium, 4-core VM, no GPU:

* 12 s, 1280×720, 30 fps, MP4: rendered in **5.4 s** (2.2× real time), H.264 + AAC, 360 frames, 48 kHz stereo.
* A/V sync: the first note reaches the hit line in frame 60 (t = 2.000 s with a 2 s lead-in) and the audio's first sample is at 2.011 s — within the ±20 ms perceptual threshold (residual is the AAC codec's pre-echo/attack ramp).
* Production build under the site's Content-Security-Policy: 34 s 720p MP4 exported successfully.
* Original recording (`npm run test:e2e:export`, 44.1 kHz synthetic click track): every click lands on the sample where its note reaches the keys (0.00 ms error) in MP4 (H.264 + AAC) and WebM (VP9 + Opus), for the full song and a custom range starting mid-song (lead-in clicks included); audio and video lengths match within 13 ms. In "Both" mode the piano starts on the same sample; its sound reaches 30 % of its peak 13–18 ms later, which is the natural attack of the piano samples, not an offset.

Measured with the Blossom look (decals, glow, bursts, dust, key light, realistic keyboard): a 10 s 1920×1080 60 fps MP4 rendered in 14 s in headless Chromium without a GPU. `tests/e2e/determinism.html` checks that frames are pixel-identical across fresh renderers and after seeking (exports always use a fresh renderer).

## Fallback

Without WebCodecs (old Safari/Firefox), the export renders in real time to a canvas and records it with `MediaRecorder` together with the live engine's audio (WebM). It takes as long as the music and frame pacing depends on the device.

## Tips

* 1080p60 of a 4-minute song is ~14 400 frames; expect roughly 1–3× real time on a laptop with hardware encoding.
* If MP4 shows a non-H.264 codec badge, the browser lacks an H.264 encoder (some Linux builds); the file still plays in browsers, VLC and on YouTube.
