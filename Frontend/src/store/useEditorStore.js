// The one store. Edit state is ONLY `removedRanges` (SRS §3.1); everything else the
// editor shows (deleted words, EDL, timeline clips) is derived from it with src/lib.
//
// Undo/redo keeps snapshots of removedRanges. They are tiny arrays, and snapshots
// can't drift the way replaying operations can. One stack covers every editing mode.

import { create } from 'zustand';
import { addRange, subtractRange } from '../lib/ranges.js';
import { deriveGaps, buildTranscriptItems } from '../lib/transcript.js';
import { itemsInRange } from '../lib/timeline.js';

const HISTORY_LIMIT = 200;

const initialState = {
  // media
  file: null,
  videoUrl: null,
  duration: 0,
  videoWidth: 0,
  videoHeight: 0,

  // pipeline status: idle | loading | extracting | model | transcribing | ready | error
  status: 'idle',
  progress: 0, // 0..1 for the current stage
  statusText: '',
  error: null,
  device: null, // 'webgpu' | 'wasm'

  // transcript (fixed after transcription)
  words: [],
  gaps: [],
  items: [], // words + gap tokens in time order

  // edit state
  removedRanges: [],
  past: [],
  future: [],

  // timeline visuals (derived from the media, not edit state)
  peaks: null, // Float32Array, 0..1 loudness per 10 ms
  thumbnails: [], // [{ t, url }] sorted by t
  energy: null, // Float32Array, RMS per 10 ms (acoustic evidence for filler detection)

  // filler review (UI state, not edit state: nothing changes until Apply commits cuts)
  // null | { phase: 'analyzing' | 'review' | 'applied' | 'error', candidates, selected, audioUsed, applied, error }
  fillerReview: null,

  // ui
  selection: null, // { anchor, focus } indices into items
  selectionRange: null, // { start, end } exact time range from a timeline drag (overrides item bounds)
  activeWordId: null,
};

export const useEditorStore = create((set, get) => ({
  ...initialState,

  // ---- pipeline ----
  setStatus: (status, statusText = '', progress = 0) => set({ status, statusText, progress, error: null }),
  setProgress: (progress, statusText) => set(statusText ? { progress, statusText } : { progress }),
  setError: (error) => set({ status: 'error', error }),
  setDevice: (device) => set({ device }),

  loadMedia: ({ file, videoUrl, duration, videoWidth, videoHeight }) => {
    const old = get().videoUrl;
    if (old) URL.revokeObjectURL(old);
    set({ ...initialState, file, videoUrl, duration, videoWidth, videoHeight, status: 'loading' });
  },

  setTranscript: (words) => {
    const sorted = [...words].sort((a, b) => a.start - b.start);
    const gaps = deriveGaps(sorted, get().duration);
    set({
      words: sorted,
      gaps,
      items: buildTranscriptItems(sorted, gaps),
      removedRanges: [],
      past: [],
      future: [],
      selection: null,
      fillerReview: null,
      status: 'ready',
      progress: 1,
      statusText: '',
    });
  },

  reset: () => {
    const old = get().videoUrl;
    if (old) URL.revokeObjectURL(old);
    set(initialState);
  },

  // ---- editing ----
  /** Replace removedRanges and record history. Every edit goes through here. */
  commit: (next) => {
    const { removedRanges, past } = get();
    set({
      removedRanges: next,
      past: [...past, removedRanges].slice(-HISTORY_LIMIT),
      future: [],
    });
  },

  removeRange: (range) => get().commit(addRange(get().removedRanges, range)),
  restoreRange: (range) => get().commit(subtractRange(get().removedRanges, range)),

  undo: () => {
    const { past, future, removedRanges } = get();
    if (!past.length) return;
    set({
      removedRanges: past[past.length - 1],
      past: past.slice(0, -1),
      future: [removedRanges, ...future],
    });
  },

  redo: () => {
    const { past, future, removedRanges } = get();
    if (!future.length) return;
    set({
      removedRanges: future[0],
      past: [...past, removedRanges],
      future: future.slice(1),
    });
  },

  // ---- media visuals ----
  setPeaks: (peaks) => set({ peaks }),
  setEnergy: (energy) => set({ energy }),
  setFillerReview: (fillerReview) => set({ fillerReview }),
  addThumbnail: (thumb) =>
    set({ thumbnails: [...get().thumbnails, thumb].sort((a, b) => a.t - b.t) }),

  // ---- ui ----
  setSelection: (selection) => set({ selection, selectionRange: null }),
  /** Select an exact (already snapped) time range from the timeline. */
  setRangeSelection: (range) => {
    if (!range || range.end - range.start < 1e-3) {
      set({ selection: null, selectionRange: null });
      return;
    }
    const hit = itemsInRange(get().items, range);
    set({ selectionRange: range, selection: hit ? { anchor: hit.lo, focus: hit.hi } : null });
  },
  setActiveWordId: (id) => {
    if (get().activeWordId !== id) set({ activeWordId: id });
  },
}));

/** Selected items as { lo, hi, range } or null. */
export function getSelectionSpan(state) {
  const { selection, selectionRange, items } = state;
  if (selectionRange) {
    const lo = selection ? Math.min(selection.anchor, selection.focus) : null;
    const hi = selection ? Math.max(selection.anchor, selection.focus) : null;
    return { lo, hi, range: selectionRange };
  }
  if (!selection || !items.length) return null;
  const lo = Math.min(selection.anchor, selection.focus);
  const hi = Math.max(selection.anchor, selection.focus);
  return { lo, hi, range: { start: items[lo].start, end: items[hi].end } };
}