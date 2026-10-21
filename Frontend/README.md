# The Scarlet Rewrite

A browser-native, text-driven video editor (PS 09). Upload a video, get a word-level
transcript generated in the browser, and edit the video by deleting words. Nothing is
uploaded to a server.

## Run it

Requires Node 20+ and a recent desktop Chrome or Edge.

```bash
npm install
npm run dev      # open the printed http://localhost:5173
npm test         # unit tests for the edit logic (src/lib)
```

The first transcription downloads the Whisper model (~80–150 MB). After that the
browser caches it.

## What works now (Phase 1 + core of Phase 2)

- Upload MP4 / WebM / MOV, with clear errors for unsupported files
- Audio extracted and resampled to 16 kHz mono
- Whisper (Transformers.js) in a Web Worker: WebGPU, falling back to WASM, with a progress bar
- Long audio is split into ≤ 29 s chunks at the quietest moment; silent chunks are skipped
- Read-only transcript: click a word to seek, drag or shift-click to select, Delete to cut, Delete again to restore
- Gap tokens (`[ pause 0.8s ]`, `[ no speech 1:40 ]`) for silences over 0.5 s, deletable like words
- Undo / redo (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y), Space to play/pause
- Preview skips removed ranges while playing; the current word is highlighted
- Edited length shown next to the original length
- **Export MP4**, rendered entirely in the browser in a Web Worker (WebCodecs + mediabunny):
  progress bar, cancel, in-dialog preview, download, and render speed (× real time)

## Timeline (Phase 4)

`src/components/Timeline.jsx`, under the preview:

- **Tracks:** ruler, word track (one chip per word / pause), video filmstrip, audio waveform.
  Thumbnails come from a hidden `<video>` (`src/media/thumbnails.js`); the waveform from the
  same 16 kHz audio Whisper uses (`computePeaks`).
- **Synchronised:** the timeline has no edit state of its own. It reads `words`, `gaps` and
  `removedRanges` from the store, and the playhead reads the `<video>` time every frame. Cutting
  in the transcript shows up on the timeline instantly, and the other way round.
- **Never mid-word:** every time the timeline produces goes through `snapSeek` / `snapCut`
  (`src/lib/timeline.js`, `src/lib/snap.js`). Clicking or scrubbing seeks to the nearest word
  edge (free inside silences). Drag-selections and trim handles snap the same way. The dashed
  hover guide shows where a click will land before you click.
- **Edit:** drag on the tracks to select a range, then Delete. Drag the red handles on a cut to
  trim it. Click a word chip to select it; Shift-click extends the selection.
- **Navigate:** ← / → step word edge by word edge. Ctrl/⌘ + wheel or `+` / `-` zoom, `0` fits.
  The crosshair button follows the playhead during playback.

The preview has custom controls: the scrub bar runs over the *edited* timeline (cut points are
marked), snaps the same way, and a live caption shows the current word.

Light and dark themes: toggle in the header. The choice is remembered per browser and defaults
to the system setting. Colours are CSS variables in `src/index.css` (`--c-*`), used through
Tailwind tokens such as `bg-surface`, `text-fg`, `border-line`.

## Export pipeline

`src/media/exporter.js`, run from `src/workers/export.worker.js`:

1. Build the EDL from `removedRanges` (the same function the preview uses).
2. For each kept range, decode video frames and audio samples separately (WebCodecs via mediabunny).
3. Rebase timestamps: both tracks share one running offset, so the output is continuous and in sync.
4. Video frames are drawn onto an OffscreenCanvas, then encoded. Subtitles, titles and b-roll will be drawn here later.
5. Audio is trimmed to the exact sample at each cut, with a 5 ms fade so cuts don't click.
6. Mux to MP4 and download. Codec choice: H.264 (falls back to VP9 / AV1), AAC (falls back to Opus).

## How the code is organised

```
src/
  lib/            Pure logic, no React, no browser APIs. Fully unit-tested.
    config.js       every tunable number (gap threshold, padding, model id…)
    ranges.js       add / subtract / merge / complement time ranges
    edl.js          EDL, isSpanRemoved, nextPlayableTime, source<->output time
    transcript.js   gap derivation, transcript items, word lookup
    snap.js         snapCut for timeline mode
    timeline.js     snapSeek, word-edge stepping, ruler ticks, range-selection helpers
    chunkAudio.js   splitting audio for Whisper
  store/          Zustand store: words, removedRanges, undo/redo, selection
  media/          Browser media code: audio extraction, worker wrapper, ingest flow, player handle
  workers/        Web Workers (Whisper now; export later)
  components/     React UI
```

**The one rule:** edits only ever change `removedRanges` in the store, through
`removeRange` / `restoreRange`. Transcript, timeline, preview and export all read from
it with the functions in `src/lib/edl.js`. If you need a new kind of edit, add a
function to `src/lib`, test it, and call `commit()`.

## Team split (3 people)

| Person | Owns | First task |
| --- | --- | --- |
| **A: Media / AI** | `workers/whisper`, `media/extractAudio`, VAD, filler detection, Hinglish later | Record test videos; check whether Whisper keeps "um"/"uh" |
| **B: Export** | `workers/export` (new), WebCodecs + mediabunny | Standalone spike: one MP4 + a hard-coded EDL → cut MP4 that plays in sync |
| **C: Editor UI** | `components/`, canvas preview, aspect ratios, timeline mode, subtitles | Canvas preview with 16:9 / 9:16 / 1:1 |

Export is the biggest risk, so it starts on day 1 in parallel, not after the UI.

## 7-day plan

| Day | Goal | Done when |
| --- | --- | --- |
| 1 | Everyone runs this repo. A records 3 test clips (talking head with fillers; long silent middle; music intro). B starts the export spike. | Transcript appears for all 3 clips |
| 2 | Canvas preview + aspect ratios (C). Export spike cuts video correctly (B). Fillers tested (A). | Spike outputs a cut MP4 |
| 3 | Export wired into the app with a progress bar. | **Pass tier complete end to end** |
| 4 | Timeline mode: playhead, razor, select-delete, drag-trim with `snapCut`. Silero VAD. | Timeline and transcript edits stay in sync |
| 5 | One-click filler & pause removal. Animated word-by-word subtitles on canvas, burned in at export. | Victory features 1 and 2 |
| 6 | B-roll / titles / ducking (stretch). Performance: 1080p export speed, smooth scrubbing. | Measured export speed |
| 7 | Feature freeze. README sections below, sample export, tool disclosure, demo recording. | Submitted |

## Still to write for submission

- Rendering pipeline (WebCodecs / mediabunny), with a diagram
- Transcript sync logic (removedRanges → EDL → preview + export)
- Design choices: read-only transcript, cut snapping, no clip reordering
- Supported browsers: Chrome / Edge first; Firefox and Safari best effort
- Tool disclosure, and a sample export with verification notes