<p align="center">
  <img src="Frontend/public/logo-glow.svg" alt="The Scarlet Rewrite logo" width="140" />
</p>

<h1 align="center">The Scarlet Rewrite</h1>

<p align="center">
  <b>Edit video by editing text.</b><br />
  A browser-native, transcript-driven video editor. Transcription, editing and export all run on your own device.
</p>

<p align="center">
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-b81f28" />
  <img alt="React 19" src="https://img.shields.io/badge/react-19-b81f28" />
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-b81f28" />
</p>

---

Upload a video and The Scarlet Rewrite writes a word-level transcript in the browser with
Whisper. Delete words, pauses or filler sounds from the transcript and the matching moments
disappear from the video. When you're done, the cut MP4 is rendered in the browser as well.

Your video never leaves your machine unless you sign in and choose to save a project to the
cloud. The optional backend is only needed for accounts and saved projects.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Browser support](#browser-support)
- [Using the editor](#using-the-editor)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Optional backend](#optional-backend)
- [Development](#development)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Transcript editing:** click a word to seek, select words and press Delete to cut them, press Delete again to restore.
- **On-device speech-to-text:** Whisper via [Transformers.js](https://github.com/huggingface/transformers.js) in a Web Worker, on WebGPU with a WASM fallback.
- **Pause tokens:** silences longer than 0.5 s appear as `[ pause 0.8s ]` and can be deleted like words.
- **Word-accurate timeline:** ruler, word chips, filmstrip and waveform. Cuts and seeks always snap to word edges, so nothing is cut mid-word.
- **Razor and trim tools:** split pauses, drag-select ranges, and trim cuts with handles.
- **One-click filler removal:** finds "um", "uh", repeats and restarts using language rules and audio evidence. You review the list before anything is cut, and one undo restores the whole batch.
- **Animated subtitles:** six styles (Classic, Boxed, Karaoke, Pop, Highlight, Reveal) that you can drag and resize, burned into the export.
- **In-browser export:** MP4 rendered with WebCodecs through [mediabunny](https://github.com/Vanilagy/mediabunny), with a 5 ms audio fade at every cut so there are no clicks.
- **Undo / redo** for every kind of edit.
- **Light and dark themes.**
- **Optional cloud projects:** accounts (email or Google), autosave, version history and checksum-verified video storage.

## Quick start

Requirements: **Node.js 20+** and a recent desktop **Chrome or Edge**.

```bash
git clone https://github.com/<your-org>/scarlet-rewrite.git
cd scarlet-rewrite/Frontend
npm install
npm run dev
```

Open the printed URL (usually http://localhost:5173) and drop in an MP4, WebM or MOV file.

The first transcription downloads the Whisper model (about 80–150 MB). The browser caches it,
so later runs start straight away and work offline.

The editor runs fully without the backend. To enable accounts and saved projects, see
[Optional backend](#optional-backend).

### Production build

```bash
cd Frontend
npm run build      # outputs to Frontend/dist
npm run preview    # serves the build locally
```

## Browser support

| Browser | Status |
| --- | --- |
| Chrome / Edge (desktop) | Fully supported |
| Firefox, Safari | Best effort. WebCodecs and WebGPU support varies, so transcription may be slower and export may fail. |
| Mobile browsers | Not supported |

## Using the editor

### Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Play / pause | `Space` |
| Cut or restore the selection | `Delete` / `Backspace` |
| Undo | `Ctrl/⌘ + Z` |
| Redo | `Ctrl/⌘ + Shift + Z` or `Ctrl + Y` |
| Step to previous / next word edge | `←` / `→` |
| Selection tool / Razor tool | `V` / `C` |
| Zoom timeline | `Ctrl/⌘ + wheel` or `+` / `-` |
| Fit timeline | `0` |

### Transcript

The transcript is read-only, so typing can't change it. Click a word to seek there; drag or
Shift-click to select a range; press Delete to cut. Cut words are shown struck through and are
skipped during playback. Silences over 0.5 s appear as pause tokens (`[ pause 0.8s ]`,
`[ no speech 1:40 ]`) that you can cut like words.

### Timeline

The timeline sits under the preview and has four tracks: ruler, words, video filmstrip and audio
waveform.

- **Always in sync:** the timeline has no edit state of its own, so a cut in the transcript appears on the timeline instantly, and the other way round.
- **Never mid-word:** clicking, scrubbing, drag-selections and trim handles all snap to the nearest word edge (they move freely inside silences). A dashed guide shows where a click will land.
- **Edit:** drag across the tracks to select a range, then press Delete. Drag the red handles on a cut to trim it.
- **Razor (`C`):** click inside a pause to split it. Each piece becomes its own transcript token and timeline clip, so you can delete either one. Words can't be split; over speech, the guide turns grey.
- **Follow mode:** the crosshair button keeps the playhead in view during playback.

The preview's scrub bar runs over the *edited* timeline, marks cut points, and shows the
current word as a live caption.

### Subtitles

Click **CC** in the preview controls to turn subtitles on, and **Aa** to open the style panel.

- Choose from six styles; each style card is drawn by the real renderer, so it matches the output.
- Drag the subtitles to move them (they snap to the centre) and drag the corner square to resize. Top / Middle / Bottom presets and a size slider are also available.
- Set 1–8 words per caption. A new caption also starts at a sentence end or a real pause. Cut words never appear.
- When subtitles are on, they're burned into the exported MP4 with the same style and layout.

Subtitle settings are remembered per browser. They aren't part of undo and aren't yet saved with
cloud projects.

### Filler removal

Open **Transcript → Remove fillers**. The editor lists hesitations, discourse markers, repeated
words and restarts. Confident items are pre-selected; uncertain ones are left for you to decide.
**Remove N** applies the selection as a single edit, and **Undo** (in the panel or `Ctrl/⌘ + Z`)
reverts the whole batch.

Detection runs entirely locally with no extra model and no API calls. See
[Filler detection](#filler-detection) for how decisions are made.

### Export

Click **Export** to render the edited video. A progress bar shows render speed (× real time);
you can cancel at any point, preview the result in the dialog, and download the MP4.

## How it works

### The one rule

Every edit, of every kind, changes exactly one piece of state: `removedRanges`, a sorted list of
`{ start, end }` time ranges (in source seconds) that are cut out. It lives in the Zustand store
and changes only through `removeRange` / `restoreRange` and `commit()`.

Everything else is derived from it with the functions in `src/lib/edl.js`:

```
                      ┌──────────────────────┐
 transcript edits ──▶ │                      │ ──▶ transcript (cut words struck through)
 timeline edits   ──▶ │    removedRanges     │ ──▶ timeline (cut regions)
 filler removal   ──▶ │  (the only edit      │ ──▶ preview (skips cut ranges) + subtitles
 undo / redo      ──▶ │   state)             │ ──▶ export (EDL = kept ranges)
                      └──────────────────────┘ ──▶ autosave
```

Because the preview and the exporter read the same list through the same functions, what you
see is what you export. Undo is a snapshot of the previous list, and a saved project stores
only this list, never a new copy of the video.

To add a new kind of edit: write a pure function in `src/lib`, test it, and call `commit()`.

### Transcription pipeline

1. `media/extractAudio.js` validates the file, reads its metadata and decodes the audio to 16 kHz mono.
2. `lib/chunkAudio.js` splits long audio into 20–29 s chunks at the quietest moment and skips silent chunks, which stops Whisper from inventing words.
3. `workers/whisper.worker.js` runs `onnx-community/whisper-base_timestamped` on WebGPU (or WASM) and returns words with start and end times.
4. In parallel, `media/thumbnails.js` builds the filmstrip and waveform, and `lib/acoustics.js` computes a 10 ms energy envelope used by filler detection.

### Export pipeline

`media/exporter.js`, run inside `workers/export.worker.js`:

1. Build the EDL (the kept ranges) from `removedRanges` with the same function the preview uses.
2. For each kept range, decode video frames and audio samples separately (WebCodecs via mediabunny).
3. Rebase timestamps: both tracks share one running offset, so the output is continuous and in sync.
4. Draw each video frame onto an OffscreenCanvas, add subtitles with the same `drawCaption()` the preview uses, then encode.
5. Trim audio to the exact sample at each cut, with a 5 ms fade so cuts don't click.
6. Mux to MP4. Codecs: H.264 (falls back to VP9 / AV1) and AAC (falls back to Opus).

### Subtitle rendering

`lib/captions.js` groups the kept words into caption "pages" and rebuilds them whenever
`removedRanges` changes. `drawCaption()` draws a caption at a given time on any 2D canvas: the
preview calls it on a canvas over the video, and the exporter calls it on each frame inside the
worker. Sizes are fractions of the frame's shorter side, so output matches at any resolution and
in portrait. Only system fonts are used, because a worker's OffscreenCanvas can't see web fonts
loaded by the page.

### Filler detection

Implemented in `lib/fillers.js` with acoustic evidence from `lib/acoustics.js`.

1. **Candidates** come from the Whisper words:
   - hesitations: um, uh, erm (strong); ah, hmm, er (weak, can be genuine reactions)
   - context words: like, well, so, you know, I mean, kind of / sort of, actually, basically, literally
   - repeated words, restarted 2–3 word phrases, and cut-off words ("th- the")
   - audio only: voiced sound inside a pause with no transcribed word (Whisper often drops "um")
2. **Context rules** use neighbouring words and Whisper's punctuation. For example, "I like", "looks like" and "the like button" → KEEP; ", like," → filler-leaning; "as well" and "a kind of" → KEEP; "that that" and "very very" → review.
3. **Acoustic evidence** from the energy envelope:
   - silence before and after the word, measured in the audio rather than from timestamps
   - how drawn out the word is relative to the speaker's own pace
   - steadiness (a held vowel)
   - loudness (a stressed word is less likely to be a filler)
   - sanity checks: no sound where the word should be, or a word stretched past 1.5 s, downgrades it to review

   Pitch isn't used, because it would mean keeping the raw samples (about 230 MB per hour).
4. **Labels:** score ≥ 0.75 → FILLER, ≤ 0.3 → KEEP, otherwise UNCERTAIN. Context words reach FILLER only with audio evidence; hedges and adverbs (kind of, basically…) never do. Unlabelled sounds are always UNCERTAIN.

Scores are rule scores, not probabilities. The thresholds in `lib/config.js` are hand-set
starting points and haven't been tuned on labelled data yet; see
[Evaluating filler accuracy](#evaluating-filler-accuracy).

Each candidate's cut is a source-time interval clipped so it never overlaps a neighbouring word.
Repeats also absorb the short gap before the second copy. Applying merges the selected cuts into
`removedRanges` with one `commit()`, so preview, timeline, transcript, autosave and export all
follow automatically.

There is deliberately no LLM in this step: sending transcripts out would break the
on-device guarantee, an LLM can't hear the audio, and its confidence isn't calibrated.
Ambiguous cases go to the user instead.

## Project structure

```
.
├── Frontend/                 The editor (React + Vite)
│   ├── index.html
│   ├── public/               Favicon and logo
│   ├── functions/api/        Cloudflare Pages Function that proxies /api to the backend
│   └── src/
│       ├── main.jsx, App.jsx
│       ├── components/       React UI: transcript, timeline, preview, subtitles, export
│       ├── lib/              Pure logic: no React, no browser APIs, fully unit-tested
│       │   ├── config.js       every tunable number (gap threshold, padding, model id…)
│       │   ├── ranges.js       add / subtract / merge / complement time ranges
│       │   ├── edl.js          EDL, isSpanRemoved, nextPlayableTime, source↔output time
│       │   ├── transcript.js   gap derivation, transcript items, word lookup
│       │   ├── snap.js         snapCut for timeline edits
│       │   ├── timeline.js     snapSeek, word-edge stepping, ruler ticks, range helpers
│       │   ├── chunkAudio.js   splitting audio for Whisper
│       │   ├── fillers.js      filler / disfluency detection → cuts
│       │   ├── acoustics.js    energy envelope, pauses, voiced runs
│       │   ├── captions.js     caption pages, layout and drawing
│       │   └── captionStyles.js the six subtitle styles
│       ├── store/            Zustand stores: editor (removedRanges, undo/redo), subtitles, theme
│       ├── media/            Audio extraction, ingest flow, thumbnails, player handle, exporter
│       ├── workers/          Web Workers: Whisper, export, SHA-256 hashing
│       ├── account/          Sign-in and saved-project dialogs (optional backend)
│       └── persistence/      Save, autosave, restore and upload logic (optional backend)
├── Backend/                  Optional API for accounts and saved projects (Express + PostgreSQL)
└── docker-compose.yml        Local PostgreSQL for the backend
```

## Optional backend

The backend adds accounts (email/password or Google) and saved projects with autosave, version
history and video storage in any S3-compatible store or Cloudinary. Guests never need it.

```bash
docker compose up -d db          # PostgreSQL 16 on :5432
cd Backend
cp .env.example .env             # fill in JWT_ACCESS_SECRET, plus storage / Google if you have them
npm install
npm run migrate
npm run dev                      # http://localhost:4000/api/health
```

Then run the frontend as usual; Vite proxies `/api` to port 4000 in development.

See [`Backend/README.md`](Backend/README.md) for the data model, API reference, storage setup,
security notes and deployment (Render, Neon, Cloudflare Pages).

> **Never commit `.env` files.** Only `.env.example` belongs in the repository. If a real
> `.env` is ever shared, rotate every key in it.

## Development

### Tests

```bash
cd Frontend && npm test     # edit logic, filler detection, captions, persistence (Node's built-in test runner)
cd Backend && npm test      # API tests; needs TEST_DATABASE_URL (see Backend/README.md)
```

The logic in `Frontend/src/lib` is pure JavaScript with no browser APIs, so its tests run in
plain Node with no extra packages.

### Configuration

Frontend settings (all optional) go in `Frontend/.env.local`; copy `Frontend/.env.example` to start.
Only `VITE_*` values reach the browser, so never put secrets here.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api` | Where the browser calls the API. Keep `/api` so requests stay same-origin |
| `VITE_GOOGLE_CLIENT_ID` | empty | Enables "Sign in with Google"; leave empty to hide it |
| `VITE_MAX_UPLOAD_MB` | `2048` | Largest video that can be saved to an account |
| `API_DEV_TARGET` | `http://localhost:4000` | Dev only: where the Vite proxy forwards `/api` |

Every tunable number in the editor (pause threshold, Whisper model, chunk sizes, filler
thresholds) lives in `Frontend/src/lib/config.js`.

### Theming

Colours are CSS variables in `src/index.css` (`--c-*`), used through Tailwind tokens such as
`bg-surface`, `text-fg` and `border-line`. The theme follows the system setting by default and
is remembered per browser.

## Known limitations

- **Missing fillers:** Whisper (base) often leaves out "um" / "uh", and Transformers.js doesn't support `prompt_ids`, so it can't be prompted to transcribe verbatim. Detection of unlabelled sounds only partly covers this.
- **Timestamp accuracy:** Whisper word timestamps (cross-attention DTW) can be off by tens to hundreds of milliseconds, and cuts follow them.
- **Undetected disfluencies:** self-repairs with different wording ("I went — we went") and stutters inside one Whisper word ("I-I") aren't detected.
- **English only.** The model is multilingual, so other languages are a config change away but untested.
- **Large files:** audio extraction currently decodes the whole file in memory, which is fine for a few hundred MB.
- **Untested on real speech:** filler detection has been tested on synthetic transcripts and tone-burst audio, not yet on labelled real speech.

### Evaluating filler accuracy

Help here is very welcome. A suggested procedure:

1. Collect 20–30 clips (several speakers, accents and microphones), transcribe them in the app, and label each Whisper word as filler / not filler. Also mark fillers missing from the transcript, with their times.
2. Run `detectFillers` on the saved words plus energy, and count:
   - **false positives:** meaningful words labelled FILLER. This is the costly error, because it deletes speech.
   - **false negatives:** labelled fillers that came out as KEEP or are missing.
   - how many items land in UNCERTAIN (the review workload).
3. Report precision of FILLER (target ≥ 0.95) and recall over FILLER + UNCERTAIN, per category. Report fillers Whisper never transcribed separately, since they're a speech-recognition limit, not a classifier limit.
4. Tune thresholds and weights on half the clips and report results on the other half.

## Roadmap

- [ ] Aspect-ratio presets (16:9, 9:16, 1:1) in preview and export
- [ ] Titles and b-roll overlays (the exporter already draws every frame through a canvas)
- [ ] Audio ducking for background music
- [ ] Voice activity detection for better pause and sound detection
- [ ] Streaming audio decode for very large files
- [ ] Save subtitle settings with cloud projects
- [ ] More languages, starting with Hinglish
- [ ] Tuned filler thresholds based on labelled data

## Contributing

Contributions are welcome. Before you start:

1. Open an issue to discuss larger changes.
2. Fork the repo and create a branch from `main`.
3. Keep the one rule: edits change only `removedRanges`. Put new logic in `src/lib` as pure functions with tests.
4. Run `npm test` in `Frontend` (and `Backend` if you changed it) before opening a pull request.
5. Describe what you changed and how you tested it in the PR.

Bug reports are most useful with the browser version, the video format and length, and steps to
reproduce.

## Acknowledgements

- [Whisper](https://github.com/openai/whisper) by OpenAI, and the ONNX exports by [onnx-community](https://huggingface.co/onnx-community)
- [Transformers.js](https://github.com/huggingface/transformers.js) by Hugging Face
- [mediabunny](https://github.com/Vanilagy/mediabunny) for WebCodecs demuxing and muxing
- [React](https://react.dev), [Vite](https://vite.dev), [Tailwind CSS](https://tailwindcss.com), [Zustand](https://github.com/pmndrs/zustand), [hash-wasm](https://github.com/Daninet/hash-wasm)

## License

No license has been chosen yet. Until one is added, all rights are reserved by the authors.