# Architecture

Piano2Vision is a **local-first single-page app**. The browser does the heavy lifting — neural transcription, sampled-piano synthesis, rendering and video encoding — so the site can be hosted as static files on Netlify with no per-user compute cost. An optional processing server covers the two things a browser cannot do well or legitimately on its own: fetching YouTube audio and AI source separation.

```
┌──────────────────────────── Browser ────────────────────────────┐
│  React UI (Vite, Tailwind)        zustand stores                 │
│   Home · Import · Studio · Library · Settings                   │
│                                                                  │
│  Import ─► decode (Web Audio / mediabunny) ─► 22.05 kHz mono     │
│         ─► Web Worker: TF.js Basic Pitch (WebGL ▸ WASM ▸ CPU)    │
│         ─► note extraction ─► cleanup ─► hands ─► beats ─► key   │
│         ─► Easy / Medium / Hard arrangements ─► IndexedDB        │
│                                                                  │
│  Studio ─► PlaybackController (AudioContext clock, look-ahead)   │
│            └► PianoEngine (samples, pedal, reverb, limiter)      │
│         ─► PianoRollRenderer (canvas, reads the audio clock)     │
│         ─► Export: OfflineAudioContext + same renderer ─►        │
│            WebCodecs (mediabunny) ─► MP4/WebM in OPFS            │
└───────────────┬──────────────────────────────┬──────────────────┘
                │ static files + 1 function     │ optional, user-configured
        ┌───────▼────────┐              ┌───────▼───────────────────┐
        │    Netlify     │  token (HMAC)│ Processing server (FastAPI)│
        │  dist/, CDN    ├─────────────►│ yt-dlp · Demucs · ffmpeg   │
        │ backend-token  │              │ Docker; local/Fly/Cloud Run│
        └────────────────┘              └───────────────────────────┘
```

## Technology choices

| Need | Choice | Why |
| --- | --- | --- |
| UI | React 19 + TypeScript + Vite + Tailwind v4 | Requested stack; fast builds; code-split pages |
| State | zustand | Tiny, selector-based; high-frequency values (playback time, pressed keys) stay **outside** React so playback never re-renders the UI |
| Transcription | Spotify **Basic Pitch** model on **TensorFlow.js** | Polyphonic, instrument-agnostic, small (≈0.9 MB), runs client-side. A piano-only model (Onsets & Frames / ByteDance) would be more accurate on solo piano but is 10–200× larger and fails on full mixes. |
| Inference runtime | TF.js WebGL → WASM (SIMD) → CPU | Best available backend is picked automatically; software WebGL is detected and skipped in favour of WASM |
| Source separation | **Demucs** `htdemucs_6s` (server, optional) | State of the art with a dedicated piano stem; too heavy for the browser |
| Piano sound | Own Web Audio sampler + **Salamander Grand V3** (5 velocity layers) and **Upright KW** | Tone.js's Sampler has no velocity layers and doesn't run in `OfflineAudioContext` exports; our engine runs identically live and offline |
| Rendering | Canvas 2D | Visible-note culling keeps it cheap; the same class renders exported frames |
| Video | **WebCodecs** via **mediabunny** (+ WASM AAC encoder fallback) | Frame-exact, faster than real time, H.264/AAC MP4 in Chrome/Edge/Safari/Firefox 130+. FFmpeg.wasm was rejected: ~30 MB download, slower, memory-hungry. MediaRecorder is kept only as a fallback. |
| MIDI files | @tonejs/midi | Robust parser/writer |
| Storage | IndexedDB (`idb`) + `localStorage` for preferences + OPFS for export temp files | No account required; large blobs (audio, model output, media) stay on device |

### Why no Supabase (yet)

Supabase was considered for accounts and cloud sync. The app is deliberately **local-first**: no sign-up, nothing uploaded, no database bill. Songs can be moved between devices with *Export → Project file*. Cloud sync can be added later without changing the data model (each `Song` is a self-contained JSON document; binary blobs are keyed by song id) — a Supabase table with Row Level Security on `owner = auth.uid()` plus a private Storage bucket per user would map directly onto the IndexedDB stores.

## Data model

```ts
Song {
  id, title, artist, duration, source, tempo{bpm, beats[], beatsPerBar, downbeatIndex, confidence}, key,
  transcription{method, estimated, params, backend, warnings, confidence},
  base: Note[]                 // cleaned full transcription
  arrangements: { easy, medium, hard: { notes: Note[], pedal: PedalRange[], edited } }
}
Note { id, midi, start, dur, vel (0..1), hand: 'L' | 'R' }
```

IndexedDB stores: `songs`, `summaries` (fast library listing), `audio` (original file, for A/B listening), `posteriors` (8-bit quantised model output, for instant re-detection), `media` (background images/videos).

## Timing & synchronisation

* The **audio clock** (`AudioContext.currentTime`) is the single source of truth. The renderer asks the player for the current song time every animation frame, so dropped frames never cause drift.
* Notes are scheduled ~200 ms ahead by a 25 ms timer ("two clocks" pattern). Speed changes, seeks and loop wrap-around re-anchor the clock at an exact context time.
* Visual time is compensated for the device's output latency **and** the engine's own 12 ms processing latency (two `DynamicsCompressorNode`s with fixed 6 ms look-ahead). The metronome and the original recording are delayed by the same 12 ms so all three line up.
* Exports are rendered offline: frame *i* is drawn at exactly *i / fps* and the audio is rendered sample-accurately, so audio/video sync is by construction (measured ≤ 10 ms, see VIDEO_EXPORT.md).

## Performance

* Transcription runs in a Web Worker in 2-second windows (batched on WebGL), with tensors disposed every batch; the UI never blocks. A 5 min 17 s recording took **39 s** on the WASM backend (4-core cloud VM, no GPU).
* Model output is stored 8-bit so detection can be re-tuned in about a second.
* The renderer binary-searches the first visible note and only draws what is on screen; React never re-renders during playback.
* Long WAV/video renders are chunked (45–60 s chunks with an 18 s pre-roll so ringing notes and reverb carry across chunk boundaries) and video is streamed to the Origin Private File System, keeping memory bounded.

## Known limitations

* **Transcription is an estimate.** On solo piano it is good (note-onset F1 ≈ 0.94 on our rendered benchmark); on dense full mixes it is noticeably worse — use the *Full song* preset, server-side separation, or edit the result. The UI labels every audio transcription as AI-estimated.
* Sustain pedal is not transcribed from audio (Basic Pitch doesn't predict it); note durations already include the ringing. MIDI imports keep their pedal.
* Hand assignment and the Easy/Medium arrangements are heuristics — good starting points, not engraved editions.
* YouTube: browsers cannot legally/technically download YouTube media. Use the processing server (your responsibility to use it for content you have rights to) or record the embedded player's tab audio (Chrome/Edge desktop, real time).
* Video export needs WebCodecs for the fast path; older browsers fall back to real-time WebM recording.
* Web MIDI is unavailable in Safari; the computer keyboard and on-screen keys work everywhere.
