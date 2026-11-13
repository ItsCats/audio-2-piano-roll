/**
 * Everything Piano2Vision uses that was made by someone else, with its licence.
 * Shown on the Credits page (/credits). Keep this list in sync when adding a model, sound,
 * font or library (and check the licence allows redistribution from a public website).
 */
export interface Credit {
  name: string;
  /** What Piano2Vision uses it for. */
  use: string;
  author: string;
  license: string;
  licenseUrl?: string;
  url: string;
  /** Changes we made, or other notes required by the licence. */
  note?: string;
}

export interface CreditGroup {
  id: string;
  title: string;
  intro?: string;
  items: Credit[];
}

const LIC = {
  apache: 'https://www.apache.org/licenses/LICENSE-2.0',
  mit: 'https://opensource.org/license/mit',
  isc: 'https://opensource.org/license/isc-license-txt',
  mpl: 'https://www.mozilla.org/en-US/MPL/2.0/',
  lgpl: 'https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html',
  ofl: 'https://openfontlicense.org/',
  ccby3: 'https://creativecommons.org/licenses/by/3.0/',
  ccby4: 'https://creativecommons.org/licenses/by/4.0/',
  ccbyncsa4: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  bsd3: 'https://opensource.org/license/bsd-3-clause',
  unlicense: 'https://unlicense.org/',
};

export const CREDITS: CreditGroup[] = [
  {
    id: 'models',
    title: 'AI models',
    intro: 'These run on your own device, inside your browser. Your audio is never uploaded to use them.',
    items: [
      {
        name: 'Basic Pitch',
        use: 'Listens to the audio and detects the notes (the default transcription model).',
        author: 'Spotify — Rachel Bittner, Juan José Bosch, David Rubinstein, Gabriel Meseguer-Brocal, Sebastian Ewert',
        license: 'Apache-2.0',
        licenseUrl: LIC.apache,
        url: 'https://github.com/spotify/basic-pitch',
        note: 'We run the published TF.js model with our own inference and note-extraction code.',
      },
      {
        name: 'High-resolution Piano Transcription',
        use: 'The optional “High-accuracy piano model”: trained only on piano recordings, it finds the notes, their exact start and end times and how hard each key was struck. Downloaded only when you choose it.',
        author: 'Qiuqiang Kong, Bochen Li, Xuchen Song, Yuan Wan, Yuxuan Wang (ByteDance; “High-resolution Piano Transcription with Pedals by Regressing Onset and Offset Times”, IEEE/ACM TASLP 2021)',
        license: 'CC BY 4.0 (weights); MIT & Apache-2.0 (code)',
        licenseUrl: LIC.ccby4,
        url: 'https://zenodo.org/records/4034264',
        note: 'Changed: we converted the note model of the checkpoint “CRNN_note_F1=0.9677_pedal_F1=0.9186.pth” (Zenodo record 4034264, DOI 10.5281/zenodo.4034264) to ONNX with float16 weights (the pedal model is left out, the STFT basis is computed inside the model, and the file is split into 5 pieces for hosting) and rewrote its note post-processing in TypeScript. Model code: github.com/qiuqiangkong/piano_transcription_inference (MIT) and github.com/bytedance/piano_transcription (Apache-2.0); the audio front end inside the model comes from torchlibrosa (MIT, Qiuqiang Kong). The model was trained on the MAESTRO dataset.',
      },
      {
        name: 'SCNet',
        use: 'Separates a song into vocals, drums and the rest, so the melody can follow the singer and drums don’t turn into false notes.',
        author: 'Weinan Tong et al. (“SCNet: Sparse Compression Network for Music Source Separation”, ICASSP 2024); ONNX conversion by audiojs; checkpoint via ZFTurbo’s Music-Source-Separation-Training',
        license: 'MIT',
        licenseUrl: LIC.mit,
        url: 'https://github.com/starrytong/SCNet',
        note: 'int8 ONNX file from huggingface.co/audiojs/scnet, served unmodified from this site with the author’s permission to redistribute converted copies.',
      },
      {
        name: 'CREPE (tiny)',
        use: 'A small pitch tracker for the singer’s voice. Shipped with the site for vocal-melody work; the current import does not run it yet.',
        author: 'Jong Wook Kim, Justin Salamon, Peter Li, Juan Pablo Bello (CREPE); PyTorch weights from torchcrepe by Max Morrison',
        license: 'MIT',
        licenseUrl: LIC.mit,
        url: 'https://github.com/marl/crepe',
        note: 'Converted to ONNX by us from torchcrepe’s “tiny” weights (see public/models/crepe/README.md).',
      },
      {
        name: 'Sheet Music Transformer (SMT)',
        use: 'Reads printed piano music from PDFs and photos (beta). Downloaded only when you first read a PDF or photo.',
        author: 'Antonio Ríos-Vila, Jorge Calvo-Zaragoza, Thierry Paquet (“Sheet Music Transformer: End-To-End Optical Music Recognition Beyond Monophonic Transcription”, ICDAR 2024)',
        license: 'MIT',
        licenseUrl: LIC.mit,
        url: 'https://github.com/antoniorv6/SMT',
        note: 'Two of the authors’ published checkpoints: antoniorv6/smt-grandstaff for PDFs and antoniorv6/smt-camera-grandstaff for photos (huggingface.co). Changed: we converted each to two ONNX files (image encoder; text decoder with a key/value cache) with 8-bit weights, split into pieces for hosting, and wrote our own page clean-up, staff finding, **kern reading and MusicXML output in TypeScript (see public/models/omr/README.md).',
      },
      {
        name: 'GrandStaff and Camera-GrandStaff datasets',
        use: 'The printed piano music (and its camera-photo versions) the sheet-music reader was trained on by its authors. Not included in the app.',
        author: 'Antonio Ríos-Vila, David Rizo, José M. Iñesta, Jorge Calvo-Zaragoza (“End-to-end optical music recognition for pianoform sheet music”, IJDAR 2023)',
        license: 'Training data of the model above (not shipped)',
        url: 'https://huggingface.co/datasets/antoniorv6/grandstaff',
      },
    ],
  },
  {
    id: 'sounds',
    title: 'Piano sounds',
    items: [
      {
        name: 'Salamander Grand Piano V3',
        use: 'The grand piano you hear (Yamaha C5), with damper and pedal noises.',
        author: 'Alexander Holm',
        license: 'CC BY 3.0',
        licenseUrl: LIC.ccby3,
        url: 'https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html',
        note: 'Changed: 5 of the 16 velocity layers selected, trimmed, and converted to MP3 for faster loading.',
      },
      {
        name: 'Upright Piano KW',
        use: 'The upright piano sound.',
        author: 'FreePats project (freepats.zenvoid.org)',
        license: 'CC0 (public domain)',
        licenseUrl: LIC.cc0,
        url: 'https://freepats.zenvoid.org/Piano/',
        note: 'Converted to MP3.',
      },
    ],
  },
  {
    id: 'fonts',
    title: 'Fonts & icons',
    items: [
      { name: 'Inter', use: 'Interface text and the Modern title page style.', author: 'Rasmus Andersson', license: 'SIL Open Font License 1.1', licenseUrl: LIC.ofl, url: 'https://rsms.me/inter/', note: 'Self-hosted through Fontsource (MIT).' },
      { name: 'JetBrains Mono', use: 'Numbers and times.', author: 'JetBrains', license: 'SIL Open Font License 1.1', licenseUrl: LIC.ofl, url: 'https://www.jetbrains.com/lp/mono/', note: 'Self-hosted through Fontsource (MIT).' },
      {
        name: 'Cinzel',
        use: 'Title pages of exported videos.',
        author: 'Natanael Gama (The Cinzel Project Authors)',
        license: 'SIL Open Font License 1.1',
        licenseUrl: LIC.ofl,
        url: 'https://github.com/NDISCOVER/Cinzel',
        note: 'Copyright 2020 The Cinzel Project Authors. Self-hosted through Fontsource (MIT); loaded only for title pages.',
      },
      {
        name: 'Playfair Display',
        use: 'Title pages of exported videos.',
        author: 'Claus Eggers Sørensen (The Playfair Display Project Authors)',
        license: 'SIL Open Font License 1.1',
        licenseUrl: LIC.ofl,
        url: 'https://github.com/clauseggers/Playfair-Display',
        note: 'Copyright 2017 The Playfair Display Project Authors, Reserved Font Name “Playfair Display”. Unmodified Fontsource files (MIT); loaded only for title pages.',
      },
      {
        name: 'Cormorant Garamond',
        use: 'Title pages of exported videos.',
        author: 'Christian Thalmann (The Cormorant Project Authors)',
        license: 'SIL Open Font License 1.1',
        licenseUrl: LIC.ofl,
        url: 'https://github.com/CatharsisFonts/Cormorant',
        note: 'Copyright 2015 The Cormorant Project Authors. Self-hosted through Fontsource (MIT); loaded only for title pages.',
      },
      {
        name: 'EB Garamond',
        use: 'Title pages of exported videos.',
        author: 'Georg Duffner, Octavio Pardo (The EB Garamond Project Authors)',
        license: 'SIL Open Font License 1.1',
        licenseUrl: LIC.ofl,
        url: 'https://github.com/octaviopardo/EBGaramond12',
        note: 'Copyright 2017 The EB Garamond Project Authors. Self-hosted through Fontsource (MIT); loaded only for title pages.',
      },
      {
        name: 'Great Vibes',
        use: 'The script font of title pages.',
        author: 'Robert Leuschke, TypeSETit (The Great Vibes Pro Project Authors)',
        license: 'SIL Open Font License 1.1',
        licenseUrl: LIC.ofl,
        url: 'https://github.com/googlefonts/great-vibes',
        note: 'Copyright 2010 The Great Vibes Pro Project Authors. Self-hosted through Fontsource (MIT); loaded only for title pages.',
      },
      { name: 'Lucide', use: 'Icons.', author: 'Lucide contributors', license: 'ISC', licenseUrl: LIC.isc, url: 'https://lucide.dev' },
    ],
  },
  {
    id: 'libraries',
    title: 'Software libraries',
    items: [
      { name: 'React & React DOM', use: 'The user interface.', author: 'Meta and contributors', license: 'MIT', licenseUrl: LIC.mit, url: 'https://react.dev' },
      { name: 'React Router', use: 'Pages and navigation.', author: 'Remix Software and contributors', license: 'MIT', licenseUrl: LIC.mit, url: 'https://reactrouter.com' },
      { name: 'Zustand', use: 'App state.', author: 'Poimandres', license: 'MIT', licenseUrl: LIC.mit, url: 'https://github.com/pmndrs/zustand' },
      { name: 'TensorFlow.js', use: 'Runs the Basic Pitch model (WebGL / WebAssembly).', author: 'Google and contributors', license: 'Apache-2.0', licenseUrl: LIC.apache, url: 'https://www.tensorflow.org/js' },
      { name: 'ONNX Runtime Web', use: 'Runs the SCNet separation model, the high-accuracy piano model and the sheet-music reader (WebAssembly).', author: 'Microsoft and contributors', license: 'MIT', licenseUrl: LIC.mit, url: 'https://onnxruntime.ai' },
      { name: 'Mediabunny', use: 'Video export (MP4 / WebM) and decoding unusual file types.', author: 'Vanilagy', license: 'MPL-2.0', licenseUrl: LIC.mpl, url: 'https://mediabunny.dev' },
      {
        name: 'Mediabunny AAC encoder (includes FFmpeg)',
        use: 'AAC audio for MP4 videos in browsers that can’t encode it themselves.',
        author: 'Vanilagy; FFmpeg developers',
        license: 'MPL-2.0; FFmpeg’s AAC encoder under LGPL-2.1+',
        licenseUrl: LIC.lgpl,
        url: 'https://github.com/Vanilagy/mediabunny',
        note: 'Unmodified FFmpeg source compiled to WebAssembly by the Mediabunny project; source at ffmpeg.org.',
      },
      { name: '@tonejs/midi', use: 'Reading and writing MIDI files.', author: 'Yotam Mann and contributors', license: 'MIT', licenseUrl: LIC.mit, url: 'https://github.com/Tonejs/Midi' },
      { name: 'idb', use: 'Saving your library in the browser (IndexedDB).', author: 'Jake Archibald', license: 'ISC', licenseUrl: LIC.isc, url: 'https://github.com/jakearchibald/idb' },
      {
        name: 'OpenSheetMusicDisplay',
        use: 'Draws the sheet music.',
        author: 'PhonicScore and contributors',
        license: 'BSD-3-Clause',
        licenseUrl: LIC.bsd3,
        url: 'https://opensheetmusicdisplay.org',
        note: 'Includes VexFlow (MIT, Mohit Muthanna Cheppudira), JSZip (MIT or GPL-3.0; used under MIT), loglevel and typescript-collections (MIT).',
      },
      {
        name: 'jsPDF',
        use: 'Makes the sheet-music PDF.',
        author: 'James Hall, yWorks and contributors',
        license: 'MIT',
        licenseUrl: LIC.mit,
        url: 'https://github.com/parallax/jsPDF',
        note: 'With @babel/runtime, fflate, fast-png and iobuffer (MIT), and pako (MIT and Zlib).',
      },
      {
        name: 'svg2pdf.js',
        use: 'Turns the drawn pages into PDF pages.',
        author: 'yWorks',
        license: 'MIT',
        licenseUrl: LIC.mit,
        url: 'https://github.com/yWorks/svg2pdf.js',
        note: 'With svgpath, cssesc, specificity and font-family-papandreou (MIT).',
      },
      {
        name: 'PDF.js',
        use: 'Opens PDF sheet music for the sheet-music reader (beta); loaded only when you read a PDF.',
        author: 'Mozilla and contributors',
        license: 'Apache-2.0',
        licenseUrl: LIC.apache,
        url: 'https://mozilla.github.io/pdf.js/',
        note: 'pdfjs-dist 6.4.299. Includes image decoders compiled to WebAssembly: PDFium’s JBIG2 / CCITT decoder (BSD-3-Clause, The PDFium Authors), OpenJPEG (BSD-2-Clause) and qcms (MIT, Mozilla); their licence texts are served next to them in /pdfjs/wasm/.',
      },
      {
        name: 'fflate',
        use: 'Opens compressed sheet-music files (.mxl, MuseScore .mscz) when you import them.',
        author: 'Arjun Barrett',
        license: 'MIT',
        licenseUrl: LIC.mit,
        url: 'https://github.com/101arrowz/fflate',
      },
      {
        name: 'MusicXML 4.0',
        use: 'The open sheet-music file format of the MusicXML download and of sheet-music imports.',
        author: 'W3C Music Notation Community Group',
        license: 'W3C Community Final Specification Agreement',
        licenseUrl: 'https://www.w3.org/community/about/agreements/final/',
        url: 'https://www.w3.org/2021/06/musicxml40/',
      },
      { name: 'Tailwind CSS & Vite', use: 'Styling and building the site (build tools only).', author: 'Tailwind Labs; Vite contributors', license: 'MIT', licenseUrl: LIC.mit, url: 'https://tailwindcss.com' },
    ],
  },
  {
    id: 'server',
    title: 'Optional processing server',
    intro: 'Only used if you run the self-hosted server for YouTube fetching or faster separation.',
    items: [
      { name: 'yt-dlp', use: 'Fetching audio from YouTube links you have the rights to.', author: 'yt-dlp contributors', license: 'Unlicense', licenseUrl: LIC.unlicense, url: 'https://github.com/yt-dlp/yt-dlp' },
      { name: 'FFmpeg', use: 'Decoding and converting audio.', author: 'FFmpeg developers', license: 'LGPL-2.1+ (GPL for some builds)', licenseUrl: LIC.lgpl, url: 'https://ffmpeg.org' },
      { name: 'FastAPI & Uvicorn', use: 'The web server.', author: 'Sebastián Ramírez; Encode', license: 'MIT; BSD-3-Clause', licenseUrl: LIC.mit, url: 'https://fastapi.tiangolo.com' },
      { name: 'python-multipart', use: 'Receiving uploaded audio files.', author: 'Andrew Dunham, Marcelo Trylesinski and contributors', license: 'Apache-2.0', licenseUrl: LIC.apache, url: 'https://github.com/Kludex/python-multipart' },
      { name: 'ONNX Runtime & NumPy', use: 'Running SCNet on the server.', author: 'Microsoft; NumPy developers', license: 'MIT; BSD-3-Clause', licenseUrl: LIC.bsd3, url: 'https://onnxruntime.ai' },
    ],
  },
  {
    id: 'testing',
    title: 'Used to measure accuracy (not included in the app)',
    intro: 'These recordings, scores and reference models were used only to test Piano2Vision and produce the numbers on the Accuracy page.',
    items: [
      {
        name: 'MAESTRO dataset v3',
        use: 'Piano recordings with the exact keys pressed, to score note accuracy.',
        author: 'Curtis Hawthorne et al., Google Magenta',
        license: 'CC BY-NC-SA 4.0',
        licenseUrl: LIC.ccbyncsa4,
        url: 'https://magenta.tensorflow.org/datasets/maestro',
      },
      { name: 'ASAP dataset', use: 'Aligned score of Chopin’s Ballade No. 1 (used to check an earlier measurement).', author: 'Francesco Foscarin et al.', license: 'CC BY-NC-SA 4.0', licenseUrl: LIC.ccbyncsa4, url: 'https://github.com/fosfrancesco/asap-dataset' },
      { name: 'Musopen', use: 'Recording of Chopin’s Nocturne Op. 55 No. 1.', author: 'Musopen', license: 'Public domain (CC0)', licenseUrl: LIC.cc0, url: 'https://musopen.org' },
      { name: 'Mutopia Project', use: 'Score of Debussy’s Clair de lune (used to check an earlier measurement).', author: 'Mutopia contributors', license: 'Public domain', url: 'https://www.mutopiaproject.org' },
      {
        name: 'High-resolution Piano Transcription (reference runs)',
        use: 'The original PyTorch version of the piano model above, used as a second opinion on recordings without an exact answer key and to check that our browser version gives the same notes.',
        author: 'Qiuqiang Kong, Bochen Li, Xuchen Song, Yuan Wan, Yuxuan Wang (ByteDance)',
        license: 'MIT (piano_transcription_inference); CC BY 4.0 (weights)',
        licenseUrl: LIC.ccby4,
        url: 'https://github.com/qiuqiangkong/piano_transcription_inference',
      },
      {
        name: 'Demucs',
        use: 'Made reference vocal and bass tracks for testing. Not used by the app (its weights are for research use only).',
        author: 'Alexandre Défossez et al., Meta AI',
        license: 'MIT (code); weights for research use only',
        url: 'https://github.com/facebookresearch/demucs',
      },
      { name: 'CREPE / torchcrepe', use: 'Pitch tracking of the singer and the bass on the reference tracks, to check the melody and the bass line.', author: 'Jong Wook Kim et al.; Max Morrison', license: 'MIT', licenseUrl: LIC.mit, url: 'https://github.com/maxrmorrison/torchcrepe' },
      { name: 'mir_eval & librosa', use: 'Standard accuracy metrics and audio analysis (including the pYIN pitch tracker used as an independent second check).', author: 'Colin Raffel et al.; librosa developers', license: 'MIT; ISC', licenseUrl: LIC.mit, url: 'https://github.com/mir-evaluation/mir_eval' },
    ],
  },
];

/** People whose work inspired a part of Piano2Vision (nothing of theirs is copied or included). */
export const INSPIRATION: { name: string; text: string }[] = [
  {
    name: 'Rousseau',
    text: 'Pianist and YouTube creator. The video title page styles were inspired by the classical title cards in Rousseau’s videos. Piano2Vision is not affiliated with Rousseau, and no logos or artwork were copied.',
  },
];

/** Made specifically for Piano2Vision (no third-party assets). */
export const ORIGINAL_WORK = [
  'All 13 note decal patterns (meadow, sakura, galaxy …) are drawn by code written for Piano2Vision.',
  'The title pages’ flower pattern, ornaments, light streaks and sparkles are drawn by code written for Piano2Vision (no images from others).',
  'Background scenes, light bursts, sparkle dust and key lighting are generated by our own renderer.',
  'The reverb rooms are synthesized — no recorded impulse responses are used.',
  'The demo song is J. S. Bach’s Prelude in C major, BWV 846 (public domain), written out in code.',
];
