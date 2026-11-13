# Basic Pitch model (TensorFlow.js)

`model.json` and `group1-shard1of1.bin` are the Basic Pitch note-detection model, the default
transcription model of Piano2Vision. They run in the browser (TensorFlow.js) in
`src/lib/transcription/inference.worker.ts`.

| | |
|---|---|
| Work | Basic Pitch, by Spotify (Rachel Bittner, Juan José Bosch, David Rubinstein, Gabriel Meseguer-Brocal, Sebastian Ewert) |
| Copyright | Copyright 2022 Spotify AB |
| License | Apache License 2.0 (full text in `LICENSE` next to this file) |
| Source | npm package `@spotify/basic-pitch` 1.0.1, folder `model/` (https://github.com/spotify/basic-pitch-ts) |
| Changes | none: the files are copied unmodified by `npm run copy:model` (`scripts/copy-model.mjs`) |
| `model.json` | 174,537 bytes, SHA-256 `1ed1aaee3409ec1dc098c8b01f430c0911f6fe9412e7af8086750f9e8f302f68` |
| `group1-shard1of1.bin` | 742,392 bytes, SHA-256 `b142a95737a52e1e412d5f92e73d8bb80dfe8d04941acc0702f11f4524fb377c` |

The note-extraction code that turns the model's output into notes (`src/lib/transcription/noteExtraction.ts`,
`constants.ts`, `inference.worker.ts`) is derived from spotify/basic-pitch (Apache-2.0) and modified; each of those
files says so in its header.
