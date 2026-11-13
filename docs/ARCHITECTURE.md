# Architecture

Piano2Vision is a **local-first single-page app**. The browser does the heavy lifting — neural transcription, sampled-piano synthesis, rendering and video encoding — so the site can be hosted as static files on Netlify with no per-user compute cost. An optional processing server runs source separation faster: the same SCNet model also runs in the browser.

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
        │  dist/, CDN    ├─────────────►│ yt-dlp · SCNet · ffmpeg    │
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
| Source separation | **SCNet** int8 ONNX on **onnxruntime-web** (WASM, multi-threaded when the page is cross-origin isolated); the optional server runs the same model faster | MIT-licensed weights (Demucs weights are research-only, so it was removed); 13 MB; the vocals stem feeds the right-hand melody, the accompaniment stem has no drums or vocals |
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

## Sheet music

`src/lib/sheet/` turns an arrangement into notation in pure TypeScript (unit-tested, no DOM), with our own **MusicXML 4.0** writer as the single source of truth for the screen, the PDF and the MusicXML download:

1. **Grid** (`grid.ts`): measures and a time map from the song's beats (MIDI tempo map or tracked beats; a regular grid when there are none). A MIDI file with one constant tempo that its notes don't follow (a recorded performance with a default 120 BPM header, e.g. MAESTRO) has its beats tracked from the notes instead. Estimated tempos ≥ 180 BPM use every second beat, < 45 BPM add midpoints. Music before the first downbeat becomes an implicit pickup bar.
2. **Quantize** (`quantize.ts`): each quarter picks the simplest grid that fits its onsets (Easy 8ths, Medium and Hard 16ths, or triplets only when clearly better — the same rule keeps triplets in the Medium arrangement itself), from both hands together. A quickly re-struck note moves to the next grid point instead of being dropped.
3. **Voices** (`voices.ts`): right hand → treble staff, left hand → bass staff; legato overlaps trimmed; chords; at most two voices per staff (Easy one), a held note keeping its own voice under or over moving notes; when something must stop early, the choice that cuts the least held music; small gaps closed so there are no tiny rests, never across the other voice.
4. **Rhythm, spelling, clefs** (`rhythm.ts`, `spelling.ts`, `clefs.ts`): note values with at most one dot split at beats and bar lines with ties, beams per beat, spelling on the line of fifths for the key (minor leading tone; never a double sharp or flat, E♯/B♯/F♭/C♭ only when the key has them, no two notes of a chord on one letter), accidentals per bar, clef changes only when they clearly save ledger lines, 8va / 8vb per run of extreme notes.

The Studio draws it with **OpenSheetMusicDisplay** (lazy chunk, ~360 KB gzip): in chunks of whole lines (our own line breaks), the chunk at the playback position first, yielding between chunks — a dense 3-minute Hard song shows its first line in ~40 ms and has no task over ~60 ms once the library is loaded (the first open starts the library: one ~250 ms task). Measure boxes and note positions read from OSMD drive our own cursor and tap-to-seek. Redraws of the same level (new width, zoom, edits) keep the old music on screen until the new one is complete. The **PDF** is drawn one line at a time by OSMD (our line breaks) and packed onto A4/Letter pages by svg2pdf.js into jsPDF (vector, standard fonts; titles outside Windows-1252 are drawn as an image), yielding between lines with a progress bar: a dense 3-minute Hard song takes ~3 s with no task over ~0.35 s. All of this runs under the site's CSP (no `eval`).

## Full screen

The Studio's view (piano roll or sheet music) goes full screen with **F** or its **Full screen** button (`src/components/studio/FullscreenStage.tsx`, rules in `src/lib/fullscreen.ts`): the real Fullscreen API where the browser has it, and on iPhone (no element full screen) a fixed layer over the whole viewport. Only the view and a few overlay controls show (title, Exit, play/pause, position bar, speed); while playing they fade out after 3 s and a tap brings them back. **Esc** (or F again) leaves, and edit mode (**E**) is off in full screen. The piano roll's button sits in its top-right corner; the sheet music has its own toolbar there, so its button is in that toolbar, and in full screen the toolbar moves below the overlay's top row (`--fs-top`). The overlay's position bar seeks like the Studio's (←/→ 5 s, Shift 1 s; Alt/Cmd + arrows are left to the browser). Checked by `node tests/e2e/fullscreen.mjs [--dist DIR]` (iPhone, iPad and desktop; both views).

## Known limitations

* **Transcription is an estimate.** On solo piano it is good (note-onset F1 ≈ 0.94 on our rendered benchmark); on dense full mixes it is noticeably worse — use the *Full song* preset with "Separate vocals & drums" (in the browser or on the processing server), or edit the result. The UI labels every audio transcription as AI-estimated.
* Sustain pedal is not transcribed from audio (Basic Pitch doesn't predict it); note durations already include the ringing. MIDI imports keep their pedal.
* Hand assignment and the Easy/Medium arrangements are heuristics — good starting points, not engraved editions. The same goes for sheet music written from audio: bar lines depend on the estimated beat and meter, and Hard keeps the performance's timing.
* Sound from other sites: the **Computer sound** tab records another tab's sound with the browser's screen-sharing dialog (Chrome / Edge on a computer, real time; `src/lib/audio/tabAudio.ts`). Phones can't share another app's sound with a website; there a screen recording uploaded as a video does the same. The YouTube tab (embedded player, server download) was removed in 2026-11.
* Video export needs WebCodecs for the fast path; older browsers fall back to real-time WebM recording.
* Web MIDI is unavailable in Safari; the computer keyboard and on-screen keys work everywhere.
