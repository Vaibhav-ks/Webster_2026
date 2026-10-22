// What a saved project contains, and how it goes back into the editor.
// Pure functions only (no React, no store, no browser APIs) so they are unit-tested.
//
// Saved:        words (Whisper output, never edited), removedRanges (the one edit state),
//               undo/redo history (last 50 snapshots each way), source metadata.
// Not saved:    gaps / items (derived from words), peaks / thumbnails (derived from the
//               video), file / videoUrl / workers (runtime objects), selection (UI).

import { normalize } from '../lib/ranges.js';
import { WHISPER_MODEL, WHISPER_LANGUAGE } from '../lib/config.js';

export const SCHEMA_VERSION = 1;
export const HISTORY_LIMIT = 50;
/** Saved and loaded durations may differ by this much (container rounding). */
export const DURATION_TOLERANCE = 0.1;
const SLACK = 0.05;

export class RestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const cleanRange = (r) => ({ start: r.start, end: r.end });

/** Store state -> the editorState payload the API stores. */
export function serializeEditorState({ removedRanges, past = [], future = [] }) {
  return {
    removedRanges: removedRanges.map(cleanRange),
    history: {
      past: past.slice(-HISTORY_LIMIT).map((s) => s.map(cleanRange)),
      future: future.slice(0, HISTORY_LIMIT).map((s) => s.map(cleanRange)),
    },
  };
}

export function serializeTranscript(words) {
  return {
    words: words.map(({ id, text, start, end }) => ({ id, text, start, end })),
    model: WHISPER_MODEL,
    language: WHISPER_LANGUAGE,
  };
}

/** Stable string of the parts that matter for "has anything changed since the last save". */
export function editorStateKey(state) {
  return JSON.stringify(serializeEditorState(state));
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** True when ranges are well-formed, already normalized and inside [0, duration]. */
export function rangesAreValid(ranges, duration) {
  if (!Array.isArray(ranges)) return false;
  for (const r of ranges) {
    if (!r || !isNum(r.start) || !isNum(r.end) || r.start < 0 || r.end <= r.start || r.end > duration + SLACK) return false;
  }
  const norm = normalize(ranges);
  if (norm.length !== ranges.length) return false;
  return norm.every((r, i) => Math.abs(r.start - ranges[i].start) < 1e-9 && Math.abs(r.end - ranges[i].end) < 1e-9);
}

export function wordsAreValid(words, duration) {
  if (!Array.isArray(words)) return false;
  const ids = new Set();
  for (const w of words) {
    if (!w || typeof w.id !== 'string' || typeof w.text !== 'string') return false;
    if (!isNum(w.start) || !isNum(w.end) || w.start < 0 || w.end < w.start || w.end > duration + 1) return false;
    if (ids.has(w.id)) return false;
    ids.add(w.id);
  }
  return true;
}

/** Bring older saved payloads up to the current shape. Refuses payloads from a newer app. */
export function migrateEditorState(editorState, schemaVersion) {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new RestoreError('SCHEMA_UNKNOWN', 'This project was saved in an unknown format.');
  }
  if (schemaVersion > SCHEMA_VERSION) {
    throw new RestoreError(
      'SCHEMA_NEWER',
      'This project was saved by a newer version of the app. Reload the page to update, then open it again.',
    );
  }
  // schemaVersion 1 is the current shape.
  return editorState;
}

/**
 * Check a saved project against the video that was actually loaded and produce exactly
 * what the store needs. Throws RestoreError (and touches nothing) when the cuts or the
 * transcript cannot be trusted. A broken undo history is not fatal: it is dropped and
 * the project opens with fresh history.
 *
 * @returns {{ words, removedRanges, past, future, historyDropped: boolean }}
 */
export function prepareRestore({ words, editorState, schemaVersion, savedDuration, loadedDuration }) {
  if (!isNum(loadedDuration) || loadedDuration <= 0) {
    throw new RestoreError('SOURCE_UNREADABLE', "The video's length could not be read.");
  }
  if (isNum(savedDuration) && Math.abs(savedDuration - loadedDuration) > DURATION_TOLERANCE) {
    throw new RestoreError(
      'SOURCE_MISMATCH',
      `This video is ${loadedDuration.toFixed(1)}s long but the project was saved for a ${savedDuration.toFixed(1)}s video.`,
    );
  }
  const state = migrateEditorState(editorState, schemaVersion);
  if (!wordsAreValid(words, loadedDuration)) {
    throw new RestoreError('TRANSCRIPT_INVALID', 'The saved transcript is damaged and was not loaded.');
  }
  if (!state || !rangesAreValid(state.removedRanges, loadedDuration)) {
    throw new RestoreError('EDITS_INVALID', 'The saved cuts are damaged and were not loaded.');
  }

  let past = state.history?.past ?? [];
  let future = state.history?.future ?? [];
  let historyDropped = false;
  const historyOk =
    Array.isArray(past) && Array.isArray(future) && [...past, ...future].every((s) => rangesAreValid(s, loadedDuration));
  if (!historyOk) {
    past = [];
    future = [];
    historyDropped = true;
  }

  return {
    words: words.map(({ id, text, start, end }) => ({ id, text, start, end })),
    removedRanges: state.removedRanges.map(cleanRange),
    past: past.slice(-HISTORY_LIMIT).map((s) => s.map(cleanRange)),
    future: future.slice(0, HISTORY_LIMIT).map((s) => s.map(cleanRange)),
    historyDropped,
  };
}

/** Default project title from a file name: "My Talk (final).mp4" -> "My Talk (final)". */
export function titleFromFilename(name) {
  const base = String(name ?? '').replace(/\.[^.]+$/, '').trim();
  return (base || 'Untitled project').slice(0, 200);
}
