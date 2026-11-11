# Piano audio engine

`src/lib/audio/pianoEngine.ts` is a sampled-piano voice engine written directly on the Web Audio API. It runs on a live `AudioContext` (playback, MIDI keyboard) **and** inside `OfflineAudioContext` (WAV and video export), so exports sound exactly like the Studio.

## Samples

| Library | Source | Licence | What we ship |
| --- | --- | --- | --- |
| Salamander Grand Piano V3 (Yamaha C5) | Alexander Holm, via freepats.zenvoid.org | CC-BY 3.0 | 30 pitches (every minor third, A0–C8) × **5 velocity layers** (of 16: pp, p, mf, f, ff), 88 key-release (damper) noises, pedal down/up noises |
| Upright Piano KW | freepats.zenvoid.org | CC0 | 26 pitches, one layer |

`scripts/build-samples.py` produces `public/samples/` reproducibly from the original 44.1 kHz WAV/FLAC sets: it trims leading silence (so every attack starts at t = 0), shortens tails by register (14 s in the bass down to 3 s at the top) with an exponential fade, encodes stereo VBR MP3 (decodable by every browser, including Safari) and writes `manifest.json`. Total ≈ 9.4 MB, cached for 30 days by Netlify's CDN headers.

```bash
python3 scripts/build-samples.py <SalamanderGrandPianoV3_44.1khz16bit> <UprightPianoKW-small-SFZ+FLAC-20190703> public/samples
```

## Voice model

* **Pitch**: nearest sampled note, re-pitched by `playbackRate` (at most ±1.5 semitones).
* **Velocity**: the layer recorded closest to the note's velocity is chosen (so loud notes really *sound* harder, not just louder), then a small within-layer gain correction is applied. Single-layer libraries and the *Soft* preset add a velocity- and key-tracked low-pass filter.
* **Release**: key-up starts the damper decay (time constant by register: bass strings settle more slowly). Notes from F♯6 upward have **no dampers**, as on a real grand, and ring on.
* **Re-strike**: playing a key that is still ringing damps the previous vibration quickly instead of stacking voices.
* **Mechanical noise**: Salamander's recorded damper-release and pedal noises are mixed in at a low level (can be turned off).
* **Polyphony**: 96 voices; the oldest released voices are stolen first.

## Sustain pedal

The engine is a small state machine fed with chronologically ordered events (note-on, note-off, pedal):

* pedal **down**: subsequent key releases don't damp — the voice is marked "sustained";
* pedal **up**: all sustained voices whose keys are no longer held start their damper decay;
* keys still physically held when the pedal lifts keep sounding until released.

Pedal data comes from MIDI files (CC64), from a connected MIDI keyboard's pedal, and from the arrangement's pedal lane. The pedal state is drawn in the piano roll (pedal lane + PED indicator).

## Signal chain

```
voices ─► voice bus ─► low shelf ─► high shelf ─► presence ─► chorus ─┬─► glue compressor ─► limiter ─► volume ─► out
noises ─┘                                                            └─► convolution reverb ─┘
```

* **Reverb**: impulse responses are synthesised (decorrelated stereo noise, −60 dB decay at the room's RT60, frequency-dependent damping, early reflections, deterministic seed) for Studio (0.9 s), Room (1.5 s), Hall (2.8 s) and Church (5 s).
* **Glue compressor + limiter** keep dense chords from clipping. Each `DynamicsCompressorNode` has a fixed 6 ms look-ahead; the resulting 12 ms is compensated everywhere (visuals, metronome, original-audio A/B, offline renders), verified by rendering a single note at 500 ms and measuring its onset at exactly 500 ms.

## Presets

| Preset | Library | Character |
| --- | --- | --- |
| Concert Grand | Salamander | natural, hall reverb |
| Bright Grand | Salamander | layer bias +, high shelf +4 dB, presence +2.5 dB, room |
| Upright Piano | Upright KW | woody, velocity filter, room |
| Soft Piano | Salamander | layer bias −, dark low-pass, more reverb |

User controls: volume, tone (brightness), dynamics (velocity sensitivity), reverb type and amount, chorus, pedal on/off, mechanical noise on/off, and a separate level for the original recording (A/B comparison with the transcription).

## Live scheduling

`PlaybackController` (`player.ts`) schedules events 200 ms ahead every 25 ms against the audio clock, supports playback speed (re-anchoring the clock), seamless A–B loops, hand muting, a metronome on the tracked beats (accented downbeats), count-in, and "wait for me" practice holds. MIDI-keyboard and computer-keyboard notes are played immediately through the same engine.
