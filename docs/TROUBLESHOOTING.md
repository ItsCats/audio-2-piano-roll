# Troubleshooting

### No sound
* Click Play (browsers only start audio after a user gesture). Check the volume slider and the system output device.
* While samples download the transport shows a note icon with a percentage; playback starts when the first set is ready.
* iPhone/iPad: the hardware silent switch mutes Web Audio — turn it off.

### "Could not decode this file"
The browser lacks a decoder for that codec (e.g. ALAC, WMA, some AVI). Convert to MP3/WAV/M4A, or use a processing server (it decodes anything ffmpeg can).

### Transcription is slow
The worker uses WebGL when a hardware GPU is available, otherwise WASM (SIMD), otherwise plain CPU (much slower; a warning is shown). Close other heavy tabs; keep the tab visible. Typical on WASM: about 7 s per minute of audio; with *Separate vocals & drums* about 1 minute per minute (≈ 2 min per minute in browsers without cross-origin isolation, e.g. Safari).

### Too many / too few notes
* Studio → **Notes** tab → *Re-detect notes*: raise *Note onset sensitivity* for missed notes, lower it for false ones; increase *Merge ringing re-detections* if sustained notes are broken into repeats; enable *Follow sustained melodies* for vocals.
* For songs with a singer use the *Full song* preset with *Separate vocals & drums* on (the right hand then follows the singer); a processing server makes the separation faster.
* Blend in the original recording (Sound tab → *Original recording*) to hear what's wrong, then fix notes in Edit mode.

### Tempo / beat grid is wrong
Studio → Notes → *Tempo*: type the correct BPM and press *Set tempo* (rebuilds the grid and the Easy/Medium levels).

### Hands are split wrongly
Edit mode → select notes → press **L**/**R** (or **H** to swap). Then *Easy & Medium from Hard* to propagate.

### Video export fails or is slow
* "Cannot encode … at W×H": choose WebM or a lower resolution.
* Very long exports: prefer 30 fps / 1080p; keep the tab in the foreground.
* Firefox < 130 and old Safari have no WebCodecs → real-time WebM fallback.

### MIDI keyboard not detected
Use Chrome, Edge or Firefox (Safari has no Web MIDI). Click *Connect MIDI keyboard* and allow access; devices connected later appear automatically. The computer keyboard (A W S E D F T G Y H U J K, Z/X octave) works everywhere.

### Computer sound (recording another tab)
* Needs Chrome or Edge on a computer: press **Start recording**, pick the tab that plays the music and turn on **Share tab audio**. It records in real time.
* "Nothing was recorded": the **Share tab audio** switch was off, or the song was not playing.
* iPhone / iPad and Android can't share another app's sound with a website. Use the phone's screen recorder, then upload the video under **Audio / Video** (only its sound is used), or play the song out loud and use **Record**.

### Storage full / songs disappeared
Original audio is the largest item. Delete old songs in the Library. Browsers can clear site data in private windows or when the user clears browsing data — export project files for backups.

### Processing server: "Invalid or expired access token"
`PROCESSING_SHARED_SECRET` (Netlify) and `SHARED_SECRET` (server) must match, and the server clock must be correct. For local development use `ALLOW_ANONYMOUS=1`.
