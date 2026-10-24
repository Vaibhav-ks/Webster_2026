// The one store. Edit state is ONLY `removedRanges` (SRS §3.1); everything else the
// editor shows (deleted words, EDL, timeline clips) is derived from it with src/lib.
//
// Undo/redo keeps snapshots of removedRanges. They are tiny arrays, and snapshots
// can't drift the way replaying operations can. One stack covers every editing mode.

import { create } from 'zustand';
import { addRange, subtractRange } from '../lib/ranges.js';
import { deriveGaps, buildTranscriptItems, gapCutTimes, splitTarget } from '../lib/transcript.js';
import { itemsInRange } from '../lib/timeline.js';

const HISTORY_LIMIT = 200;

/** Transcript items for the current edit state: gaps are divided at razor marks and cut edges. */
const deriveItems = (words, gaps, removedRanges, splits) =>
  buildTranscriptItems(words, gaps, gapCutTimes(splits, removedRanges));

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
  // Razor marks inside gaps (source seconds, sorted). They only divide a pause into
  // pieces you can select separately; they never change the output by themselves.
  // Undoable: splitsPast / splitsFuture run in step with past / future. Not saved with
  // projects (a mark that was used for a cut is already a cut edge in removedRanges).
  splits: [],
  splitsPast: [],
  splitsFuture: [],

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
      splits: [],
      splitsPast: [],
      splitsFuture: [],
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
  /** Apply a new edit state: re-derive the transcript items and keep the selection on the same times. */
  _apply: (patch) => {
    const s = get();
    const removedRanges = patch.removedRanges ?? s.removedRanges;
    const splits = patch.splits ?? s.splits;
    const items = deriveItems(s.words, s.gaps, removedRanges, splits);
    set({ ...patch, items, ...remapSelection(s, items) });
  },

  /** Replace removedRanges (and optionally splits) and record history. Every edit goes through here. */
  commit: (next, nextSplits) => {
    const { removedRanges, past, splits, splitsPast } = get();
    get()._apply({
      removedRanges: next,
      splits: nextSplits ?? splits,
      past: [...past, removedRanges].slice(-HISTORY_LIMIT),
      splitsPast: [...alignSplits(splitsPast, past.length), splits].slice(-HISTORY_LIMIT),
      future: [],
      splitsFuture: [],
    });
  },

  removeRange: (range) => get().commit(addRange(get().removedRanges, range)),
  restoreRange: (range) => get().commit(subtractRange(get().removedRanges, range)),

  /**
   * Razor: divide the pause under t into two pieces. Only works inside a gap (words can't
   * be split). Returns true when a split was made. Undoable like any edit.
   */
  addSplit: (t) => {
    const { gaps, removedRanges, splits } = get();
    if (!splitTarget(t, gaps, gapCutTimes(splits, removedRanges))) return false;
    get().commit(removedRanges, [...splits, t].sort((a, b) => a - b));
    set({ selection: null, selectionRange: null });
    return true;
  },

  undo: () => {
    const { past, future, removedRanges, splits, splitsPast, splitsFuture } = get();
    if (!past.length) return;
    const sp = alignSplits(splitsPast, past.length);
    get()._apply({
      removedRanges: past[past.length - 1],
      splits: sp[sp.length - 1],
      past: past.slice(0, -1),
      splitsPast: sp.slice(0, -1),
      future: [removedRanges, ...future],
      splitsFuture: [splits, ...alignSplits(splitsFuture, future.length)],
    });
  },

  redo: () => {
    const { past, future, removedRanges, splits, splitsPast, splitsFuture } = get();
    if (!future.length) return;
    const sf = alignSplits(splitsFuture, future.length);
    get()._apply({
      removedRanges: future[0],
      splits: sf[0],
      past: [...past, removedRanges],
      splitsPast: [...alignSplits(splitsPast, past.length), splits],
      future: future.slice(1),
      splitsFuture: sf.slice(1),
    });
  },

  /** Put saved edits back (opening a saved project). Razor marks aren't saved, so they start empty. */
  loadEdits: ({ removedRanges, past = [], future = [] }) => {
    get()._apply({
      removedRanges,
      past,
      future,
      splits: [],
      splitsPast: past.map(() => []),
      splitsFuture: future.map(() => []),
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

/**
 * Keep splitsPast / splitsFuture the same length as past / future. They can only drift
 * if something sets past/future directly; missing entries mean "no razor marks".
 */
function alignSplits(stack, length) {
  if (stack.length === length) return stack;
  if (stack.length > length) return stack.slice(stack.length - length);
  return [...Array(length - stack.length).fill([]), ...stack];
}

/** After an edit the items can change (gaps split); keep the selection on the same time range. */
function remapSelection(state, items) {
  const span = getSelectionSpan(state);
  if (!span) return { selection: null, selectionRange: null };
  const hit = itemsInRange(items, span.range);
  return {
    selection: hit ? { anchor: hit.lo, focus: hit.hi } : null,
    selectionRange: state.selectionRange ?? null,
  };
}

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