// Shape and semantic checks for what the editor sends, plus integrity hashing.
//
// The editor's canonical edit state is `removedRanges`: sorted, non-overlapping
// { start, end } ranges in source seconds (Frontend/src/lib/ranges.js normalize()).
// Undo/redo history is a list of earlier removedRanges snapshots; it is kept with the
// current state only (never in versions) and capped at 50 entries each way.

import crypto from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../http.js';

export const SCHEMA_VERSION = 1;
export const HISTORY_LIMIT = 50;
const MAX_RANGES = 50_000;
const MAX_WORDS = 200_000;
const DURATION_SLACK = 0.05; // seconds of float noise allowed past the end
const ORDER_EPS = 1e-6;

const finite = z.number().finite();

const Range = z
  .object({ start: finite.min(0), end: finite })
  .strict()
  .refine((r) => r.end > r.start, 'range end must be after start');
const Ranges = z.array(Range).max(MAX_RANGES);

export const EditorState = z
  .object({
    removedRanges: Ranges,
    history: z
      .object({ past: z.array(Ranges).max(500), future: z.array(Ranges).max(500) })
      .strict()
      .optional(),
  })
  .strict();

const Word = z
  .object({ id: z.string().min(1).max(40), text: z.string().max(500), start: finite.min(0), end: finite })
  .strict()
  .refine((w) => w.end >= w.start, 'word end must not be before start');

export const Transcript = z
  .object({
    words: z.array(Word).max(MAX_WORDS),
    model: z.string().max(200).optional(),
    language: z.string().max(50).optional(),
  })
  .strict();

export const SourceMeta = z
  .object({
    filename: z.string().trim().min(1).max(255),
    mimeType: z.string().max(100),
    sizeBytes: z.number().int().positive(),
    durationS: finite.positive(),
    width: z.number().int().min(0).max(100_000).nullable().optional(),
    height: z.number().int().min(0).max(100_000).nullable().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
  })
  .strict();

/** Sorted, non-overlapping and inside [0, duration]. */
export function rangesAreValid(ranges, duration) {
  let prevEnd = -Infinity;
  for (const r of ranges) {
    if (r.start < prevEnd - ORDER_EPS) return false;
    if (r.end > duration + DURATION_SLACK) return false;
    prevEnd = r.end;
  }
  return true;
}

const cleanRanges = (ranges) => ranges.map((r) => ({ start: r.start, end: r.end }));

/**
 * Validate removedRanges strictly (a bad cut list is rejected, never "fixed") and the
 * undo history leniently (an unusable history is dropped, not a reason to fail a save).
 */
export function sanitizeEditorState(state, duration) {
  if (!rangesAreValid(state.removedRanges, duration)) {
    throw new HttpError(422, 'INVALID_EDIT_STATE', 'Cut ranges are out of order or outside the video.');
  }
  let past = state.history?.past ?? [];
  let future = state.history?.future ?? [];
  const historyOk = [...past, ...future].every((snap) => rangesAreValid(snap, duration));
  if (!historyOk) {
    past = [];
    future = [];
  }
  return {
    removedRanges: cleanRanges(state.removedRanges),
    history: {
      past: past.slice(-HISTORY_LIMIT).map(cleanRanges),
      future: future.slice(0, HISTORY_LIMIT).map(cleanRanges),
    },
  };
}

export function checkWords(words, duration) {
  for (const w of words) {
    if (w.end > duration + 1) {
      throw new HttpError(422, 'INVALID_TRANSCRIPT', 'Transcript words extend past the end of the video.');
    }
  }
}

/** JSON with object keys sorted, so hashes survive jsonb's key reordering. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** What a version stores: the cut list only. */
export const versionPayload = (editorState) => ({ removedRanges: cleanRanges(editorState.removedRanges) });
export const stateHash = (payload) => sha256Hex(stableStringify(payload));
