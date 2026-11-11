# PianoVision

Turn songs, recordings, YouTube videos and MIDI files into an interactive **falling-note piano roll** — with a real sampled grand piano, Easy / Medium / Hard arrangements, note editing, practice tools with MIDI-keyboard scoring, and **1080p60 video export**.

Everything runs in the browser. Audio is transcribed on the user's device by a neural network; songs are stored locally. An optional self-hosted processing server adds YouTube fetching and AI source separation.

---

## Features

| Area | What you get |
| --- | --- |
| **Import** | MP3, WAV, M4A/AAC, MP4/MOV/WebM/MKV (audio track), FLAC, OGG/Opus, MIDI; microphone recording; YouTube (via your processing server, or by recording the official embedded player's tab audio) |
| **Transcription** | Spotify's Basic Pitch model (polyphonic) running in a Web Worker on WebGL/WASM, with a piano-tuned note-extraction pipeline, beat tracking, key detection and hand assignment. Re-tune detection afterwards without re-running the model. |
| **Arrangements** | Easy (single melody + sustained bass), Medium (melody + chord tones, simplified left hand), Hard (full transcription) — switch instantly, edit each independently |
| **Piano roll** | Smooth canvas renderer locked to the audio clock, 49–88 keys or fit-to-song, note speed/zoom, hand colours, glow, trails, sparks, guides, pedal lane, loop markers |
| **Labels** | Letters, letters+octave, solfège, MIDI numbers or custom; sharps/flats/auto-by-key; font, size, colour, position, opacity, size threshold |
| **Look** | Themes, gradients, opacity, corners, borders, shadows, keyboard themes/colours/height, scene/colour/image/video backgrounds with blur, brightness, contrast, overlay, fit, zoom, position |
| **Sound** | Salamander Grand (5 real velocity layers, damper & pedal noises) and Upright Piano KW samples; Concert Grand / Bright Grand / Upright / Soft presets; true sustain-pedal model; convolution reverb (studio → church), chorus, tone, dynamics; limiter |
| **Practice** | Speed 0.25×–2×, A–B looping, left/right/both hands, metronome, count-in, Web MIDI + computer-keyboard input, correct / wrong / missed scoring with timing, wait-for-me mode |
| **Editing** | Select, marquee, move (time + pitch), resize, add, delete, hand assignment, velocity, transpose, quantize, snap grid, undo/redo, regenerate levels |
| **Export** | Video MP4 (H.264/AAC) or WebM (VP9/Opus), 720p/1080p/1440p, 30/60 fps, 16:9 / 9:16 / 1:1, YouTube Ready & social presets, saved presets, section/full song, speed, volume, fades; MIDI; WAV; project file |
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
npm test             # 35 unit tests: note extraction, timing, beats, hands, difficulty, MIDI, practice scoring …
```

```bash
npm run test:e2e     # browser benchmark: renders known pieces with the real piano engine, transcribes them, fails on F1 regression
```

The E2E benchmark needs Chromium for Playwright (`npx playwright install chromium`). Current results: Bach BWV 846 F1 0.94, chord/melody study F1 0.88, mean onset error < 5 ms with no drift (see [docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md)).

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
- **Demucs source separation** — returns the piano stem when the song has a piano, otherwise the mix without drums, which greatly improves transcription of full band recordings.

```bash
cd server && docker build -t pianovision-server . && docker run -p 8000:8000 -e ALLOW_ANONYMOUS=1 -e ALLOWED_ORIGINS=http://localhost:5173 pianovision-server
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
    music/           types, theory, beats, hands, cleanup, difficulty, MIDI, demo
    audio/           sample library, piano engine, effects, live player, offline render, WAV
    render/          piano-roll renderer, keyboard layout, themes, backgrounds
    export/          video export (WebCodecs/mediabunny), downloads, presets
    midiInput/       Web MIDI input and practice scoring
    storage/         IndexedDB persistence
    youtube/         URL parsing, oEmbed, IFrame player, tab-audio capture
    backend/         processing-server client
  state/             zustand stores (settings, studio, transport, import, playback)
  components/        UI kit, layout, studio panels, dialogs
  pages/             Home, Import, Studio, Library, Settings
public/
  samples/           piano samples (built by scripts/build-samples.py)
  models/            Basic Pitch TF.js model
netlify/functions/   backend-token
server/              optional FastAPI processing server
tests/               unit tests and the browser accuracy harness
```

## Credits & licences

- [Basic Pitch](https://github.com/spotify/basic-pitch) model by Spotify — Apache-2.0
- [Salamander Grand Piano V3](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html) by Alexander Holm — CC-BY 3.0
- Upright Piano KW (freepats.zenvoid.org) — CC0
- TensorFlow.js (Apache-2.0), mediabunny (MPL-2.0), @tonejs/midi (MIT), React (MIT), Demucs (MIT, server only), yt-dlp (Unlicense, server only)

Users are responsible for having the rights to the music they import, and for complying with YouTube's Terms of Service.
