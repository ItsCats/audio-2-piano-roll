# Piano samples

The piano sounds of Piano2Vision. They are built by `scripts/build-samples.py` (see `docs/AUDIO_ENGINE.md`),
and `manifest.json` tells the audio engine which file plays which key and velocity. These recordings are not
covered by Piano2Vision's AGPL-3.0 license; each keeps its own license, listed below and in `LICENSE`.

## `grand/`: Salamander Grand Piano V3

| | |
|---|---|
| Work | Salamander Grand Piano V3 (Yamaha C5), 44.1 kHz / 16-bit version |
| Author | Alexander Holm |
| License | Creative Commons Attribution 3.0 Unported (CC BY 3.0), https://creativecommons.org/licenses/by/3.0/ |
| Source | https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html |
| Changes | This is a modified version (an adaptation) of the original. 5 of the 16 velocity layers kept (layers 2, 6, 9, 12, 15) for each of the 30 sampled pitches, plus the key-release (damper) noises and the pedal down/up noises. Leading silence trimmed, tails shortened by register with an exponential fade-out, converted to stereo VBR MP3. The author has not endorsed these changes or Piano2Vision. |

## `upright/`: Upright Piano KW

| | |
|---|---|
| Work | Upright Piano KW (small version, 2019-07-03 release), a Kawai upright piano |
| Author | FreePats project (freepats.zenvoid.org) |
| License | Creative Commons CC0 1.0 Universal public domain dedication, https://creativecommons.org/publicdomain/zero/1.0/ (as stated on the source page, checked 2026-11-13) |
| Source | https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html (section "Upright Piano KW") |
| Changes | Only the louder of its 2 velocity layers kept; leading silence trimmed, tails shortened with a fade-out, converted to stereo VBR MP3. (CC0 requires no attribution; it is given anyway.) |
