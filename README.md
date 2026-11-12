# Piano2Vision

Turn songs, recordings, YouTube videos and MIDI files into an interactive **falling-note piano roll** — with a real sampled grand piano, Easy / Medium / Hard arrangements, note editing, practice tools with MIDI-keyboard scoring, and **1080p60 video export**.

Everything runs in the browser. Audio is transcribed on the user's device by a neural network; songs are stored locally. An optional self-hosted processing server adds YouTube fetching and faster source separation (separation also runs in the browser).

---

## Features

| Area | What you get |
| --- | --- |
| **Import** | MP3, WAV, M4A/AAC, MP4/MOV/WebM/MKV (audio track), FLAC, OGG/Opus, MIDI; microphone recording; YouTube (via your processing server, or by recording the official embedded player's tab audio) |
| **Transcription** | Spotify's Basic Pitch model (polyphonic) running in a Web Worker on WebGL/WASM, with a piano-tuned note-extraction pipeline (register curve for the top/bottom octaves, chopped-note join), beat tracking, key detection and hand assignment. **Separate vocals & drums** (SCNet, in the browser, on by default for "Full song") puts the singer's melody on the right hand and transcribes the accompaniment without drums. Re-tune detection afterwards without re-running the model. For solo piano, an optional second model, **Solo piano – high accuracy (slower)** (ByteDance's piano transcription model, ONNX in the browser): far more accurate notes, note lengths and velocities on piano recordings, but a ≈ 41 MB one-time download, about 5× slower (≈ 38 s per audio minute with 3 threads, ≈ 97 s single-threaded) and ≈ 0.7 GB more memory, and no help for songs with vocals or drums. Measured accuracy: in-app **Accuracy** page. |
| **Arrangements** | Easy (the sung melody — or one smooth instrument tune — on 8th notes + sustained bass), Medium (tune + chord tones, simplified left hand, never more than an octave per hand), Hard (full transcription, hands rebalanced for reach) — switch instantly, edit each independently |
| **Piano roll** | Smooth canvas renderer locked to the audio clock, 49–88 keys or fit-to-song, note speed/zoom, hand colours, glow, trails, sparks, guides, pedal lane, loop markers |
| **Sheet music** | Switch the Studio between *Piano roll* and *Sheet music*: the current level (with your edits) written out on a grand staff — readable rhythms for the level, chords, two voices, ties, key signature and accidentals, clef changes and 8va/8vb. A cursor follows playback and turns the page; tap a note or bar to jump there; zoom for phones |
| **Labels** | Letters, letters+octave, solfège, MIDI numbers or custom; sharps/flats/auto-by-key; font, size, colour, position, opacity, size threshold |
| **Look** | Themes (incl. Blossom), gradients, opacity, corners, borders, shadows, falling-note glow, note brightness, keyboard themes/colours/height, flat or realistic keyboard, scene/colour/image/video backgrounds with blur, brightness, contrast, overlay, fit, zoom, position |
| **Note decals** | 13 original procedural patterns (meadow, sakura, lavender, watercolor, marble, galaxy, aurora, holographic, glitter, stained glass, geometric, wood, confetti) or your own uploaded image inside every note; size, strength, colour tint, moves-with-note or fixed-to-screen |
| **Effects** | Light bursts where notes hit the keys, drifting sparkle dust, coloured light on the keys, outline glow, light trails, sparks — each with its own switch and intensity; all deterministic so videos match the app |
| **Sound** | Salamander Grand (5 real velocity layers, damper & pedal noises) and Upright Piano KW samples; Concert Grand / Bright Grand / Upright / Soft presets; true sustain-pedal model; convolution reverb (studio → church), chorus, tone, dynamics; limiter |
| **Practice** | Speed 0.25×–2×, A–B looping, left/right/both hands, metronome, count-in, Web MIDI + computer-keyboard input, correct / wrong / missed scoring with timing, wait-for-me mode |
| **Editing** | Select, marquee, move (time + pitch), resize, add, delete, hand assignment, velocity, transpose, quantize, snap grid, undo/redo, regenerate levels |
| **Export** | Video MP4 (H.264/AAC) or WebM (VP9/Opus), 720p/1080p/1440p, 30/60 fps, 16:9 / 9:16 / 1:1, YouTube Ready & social presets, saved presets, section/full song, speed, volume, fades; MIDI; WAV; sheet music PDF (A4 / Letter, vector); MusicXML 4.0 (MuseScore, Sibelius, Finale); project file |
| **Library** | Local library with thumbnails, search, filters, sorting, favourites, project import/export |

## Quick start

Requirements: Node.js 20+ (22 recommended).

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173 and click **Play the demo**, or import a file.

Other scripts:

```bash
npm run build      # type-check + production build to dist/
```

```bash
npm test           # unit tests (vitest)
```

```bash
npm run preview    # serve the production build locally
```

## Testing

```bash
npm test             # unit tests (vitest): note extraction, timing, beats, hands, melody, difficulty, playability, MIDI, practice scoring …
```

```bash
npm run test:e2e     # browser benchmark: renders known pieces with the real piano engine, transcribes them, fails on F1 regression
```

Sheet music: `node tests/e2e/sheet.mjs --dist <build>` checks the sheet view, cursor, tap-to-seek, PDF/MusicXML downloads and drawing speed in Chromium under the production headers; `tests/sheet/export.mjs` + `tests/sheet/validate_musicxml.py` check the MusicXML against the official 4.0 schema and music21 (see the files for setup).

The E2E benchmark needs Chromium for Playwright (`npx playwright install chromium`). It is the regression gate on synthetic pieces (Bach BWV 846 F1 ≈ 0.94, chord/melody study ≈ 0.88, mean onset error ≈ 8–12 ms).

```bash
node tests/e2e/specialist.mjs [--maestro PIECE.wav]   # the high-accuracy piano model option end to end: F1 on a rendered excerpt (and a MAESTRO excerpt), cancel, support check
```

Accuracy on **real recordings** is measured with the harness in [`tests/accuracy/`](tests/accuracy/README.md) (real browser pipeline, full recordings; audio and references stay outside the repo). Latest results (2026-11-11), also on the in-app Accuracy page and in [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md):

| What | Result |
| --- | --- |
| 6 MAESTRO concert performances with exact MIDI, note F1 ("Piano solo" / "Sensitive") | 0.80 / 0.82 (was 0.78 / 0.77) |
| 5 songs with a singer: Easy right hand plays the singer's note (any octave), with separation | 50 % of sung moments (was 19 %; best possible ≈ 62 %) |
| Same songs: Easy left hand on the bass note | 71 % (was 52 %) |
| "High-accuracy piano model" in the browser, the 5 MAESTRO test-split pieces (whole recordings) | note F1 0.94–0.996, mean 0.976 (Basic Pitch "Piano solo" 0.62–0.92, mean 0.81, on the same pieces); note ends (onset + offset F1) 0.74–0.94, mean 0.84 (Basic Pitch 0.29); velocity correlation 0.97 (0.60); 94% of notes in fast runs found (58%), 88% of the top octave (36%). The original Python model scores 0.978 on the same pieces; the browser version gives the same notes for 99.7–100% of them. Chopin's Ballade No. 1 (0.98) is in the model's training data and is not counted. `tests/accuracy/specialist_eval.py` |
| Time per minute of audio (4-core CPU, no GPU), without / with separation | ≈ 7 s / ≈ 1 min with 3 threads, ≈ 2¼ min single-threaded (e.g. Safari); peak memory 0.4–0.9 / 1.9–2.2 GB. the high-accuracy piano model: ≈ 38 s with 3 threads (36–41 s, 11 recordings), ≈ 97 s single-threaded (e.g. Safari); peak tab 0.8–0.9 GB (≈ 0.7 GB above an idle tab) |

The piano presets were tuned on five of the six MAESTRO pieces (Liszt held out) and the vocal settings on the same five songs, whose reference pitch is AI-made (Demucs + CREPE); on phones separation is off by default and notes are detected on the processor (WASM). Details and caveats on the Accuracy page.

## Deploying to Netlify

1. Push this repository to a **private** GitHub repository.
2. In Netlify: **Add new site → Import an existing project → GitHub** and pick the repository. Netlify reads `netlify.toml`:
   - build command `npm run build`, publish directory `dist`, Node 22
   - SPA redirect, long-term caching for `/assets`, `/samples` and `/models`
   - security headers including a Content-Security-Policy
   - the `backend-token` function in `netlify/functions/`
3. Deploy. The site works fully without any environment variables.
4. *(Optional)* To use a processing server, set the variables below and redeploy.

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_PROCESSING_URL` | Netlify build env | Default processing-server URL shown to users (public; no secrets) |
| `PROCESSING_SHARED_SECRET` | Netlify env (functions) | Secret used to mint 10-minute access tokens for the processing server. Must equal the server's `SHARED_SECRET`. |
| `EXTRA_ALLOWED_ORIGINS` | Netlify env (functions) | Extra origins (e.g. a custom domain) allowed to request tokens |

Never commit secrets — `.env*` files are git-ignored; `.env.example` documents them.

## Optional processing server

The browser does all transcription. The server in [`server/`](server/README.md) adds:

- **YouTube audio fetching** with yt-dlp (only for content you have rights to),
- **Faster source separation** — the same SCNet model the browser runs for "Separate vocals & drums", on several CPU cores: it returns the vocal stem (the right-hand melody) and the accompaniment without drums or vocals. (Before 2.0 the server used Demucs, whose pretrained weights are research-only.)

```bash
cd server && docker build -t piano2vision-server . && docker run -p 8000:8000 -e ALLOW_ANONYMOUS=1 -e ALLOWED_ORIGINS=http://localhost:5173 piano2vision-server
```

Then enter `http://localhost:8000` in **Settings → Processing server**. See [server/README.md](server/README.md) for hosting options and costs.

## Documentation

- [Architecture & technical decisions](docs/ARCHITECTURE.md)
- [Transcription pipeline & accuracy](docs/TRANSCRIPTION.md)
- [Piano audio engine](docs/AUDIO_ENGINE.md)
- [Video export](docs/VIDEO_EXPORT.md)
- [Deployment, hosting & costs](docs/DEPLOYMENT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Project structure

```
src/
  lib/
    transcription/   Basic Pitch worker, note extraction, decoding, pipeline
    pianoSpecialist/ the high-accuracy piano model model: ONNX worker (ONNX Runtime Web) and its note post-processing
    separation/      SCNet vocals/drums separation worker (ONNX Runtime Web), stems, drum envelope
    pitch/           CREPE-tiny pitch tracker (built and measured, not wired into the import)
    music/           types, theory, beats, hands, cleanup, melody, difficulty, playability, MIDI, demo
    audio/           sample library, piano engine, effects, live player, offline render, WAV
    render/          piano-roll renderer, keyboard layout, themes, backgrounds
    export/          video export (WebCodecs/mediabunny), downloads, presets
    sheet/           sheet music: notes → measures/voices/spelling → MusicXML; OSMD view, PDF
    midiInput/       Web MIDI input and practice scoring
    storage/         IndexedDB persistence
    youtube/         URL parsing, oEmbed, IFrame player, tab-audio capture
    backend/         processing-server client
  state/             zustand stores (settings, studio, transport, import, playback)
  components/        UI kit, layout, studio panels, dialogs
  pages/             Home, Import, Studio, Library, Settings, Accuracy, Credits
public/
  samples/           piano samples (built by scripts/build-samples.py)
  models/            Basic Pitch TF.js model, SCNet separation (ONNX), piano specialist (ONNX, fp16 weights), CREPE-tiny (ONNX, not yet used)
netlify/functions/   backend-token
server/              optional FastAPI processing server
tests/               unit tests and the browser accuracy harness
```

## Credits & licences

The full list (models, sounds, fonts, libraries, server components and the data used to measure accuracy) is on the in-app **Credits** page (`/credits`, source `src/lib/credits.ts`; linked from the sidebar, Settings and the Accuracy page). In short:

- [Basic Pitch](https://github.com/spotify/basic-pitch) model by Spotify — Apache-2.0
- [Salamander Grand Piano V3](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html) by Alexander Holm — CC-BY 3.0
- Upright Piano KW (freepats.zenvoid.org) — CC0
- [SCNet](https://github.com/starrytong/SCNet) source-separation model by starrytong (Tong et al., ICASSP 2024) — MIT; int8 ONNX export by [audiojs](https://huggingface.co/audiojs/scnet); redistribution confirmed in [starrytong/SCNet#35](https://github.com/starrytong/SCNet/issues/35). Used in the browser and on the optional server; see [public/models/scnet/README.md](public/models/scnet/README.md)
- [CREPE](https://github.com/marl/crepe) "tiny" pitch model by Jong Wook Kim et al. — MIT; PyTorch weights from [torchcrepe](https://github.com/maxrmorrison/torchcrepe) by Max Morrison (MIT), converted to ONNX for this project. Shipped in `public/models/crepe/` (not yet run by the import); see [public/models/crepe/README.md](public/models/crepe/README.md)
- [High-resolution Piano Transcription](https://github.com/bytedance/piano_transcription) by Qiuqiang Kong, Bochen Li, Xuchen Song, Yuan Wan and Yuxuan Wang (ByteDance; IEEE/ACM TASLP 2021) — trained weights CC BY 4.0 ([Zenodo record 4034264](https://zenodo.org/records/4034264)), converted by us to ONNX with float16 weights (pedal model left out); inference code [piano_transcription_inference](https://github.com/qiuqiangkong/piano_transcription_inference) MIT, training code Apache-2.0. The optional "High-accuracy piano model" model; see [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md#3b-piano-specialist-solo-piano--high-accuracy-slower)
- [ONNX Runtime](https://github.com/microsoft/onnxruntime) (onnxruntime-web in the browser, onnxruntime on the server) — MIT
- TensorFlow.js (Apache-2.0), mediabunny (MPL-2.0), @tonejs/midi (MIT), React (MIT), OpenSheetMusicDisplay (BSD-3-Clause, with VexFlow MIT), jsPDF and svg2pdf.js (MIT); server only: yt-dlp (Unlicense), FastAPI (MIT), Uvicorn (BSD-3), python-multipart (Apache-2.0), NumPy (BSD-3), FFmpeg (LGPL)

Users are responsible for having the rights to the music they import, and for complying with YouTube's Terms of Service.
