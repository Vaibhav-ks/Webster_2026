// Pure helpers for the timeline: snapping the playhead, stepping between word
// boundaries, ruler tick spacing and range selections. No React, no DOM.

import { snapCut } from './snap.js';
import { overlapLength } from './ranges.js';

const EPS = 1e-4;

/**
 * Where the playhead may land for a requested time t. Same rule as cuts: inside a
 * silence it's free, anywhere else it snaps to the nearest word boundary, so the
 * playhead (and therefore the video and the highlighted word) can never sit in the
 * middle of a word.
 */
export function snapSeek(t, words, gaps, duration) {
  const clamped = Math.min(duration, Math.max(0, t));
  return Math.min(duration, Math.max(0, snapCut(clamped, words, gaps, 0)));
}

/** Sorted, de-duplicated list of every word start/end plus 0 and duration. */
export function wordBoundaries(words, duration) {
  const all = [0, duration];
  for (const w of words) all.push(w.start, w.end);
  all.sort((a, b) => a - b);
  const out = [];
  for (const t of all) {
    if (t < 0 || t > duration) continue;
    if (!out.length || t - out[out.length - 1] > EPS) out.push(t);
  }
  return out;
}

/** The first boundary strictly after t (or duration). */
export function nextBoundary(t, boundaries) {
  for (const b of boundaries) if (b > t + 0.01) return b;
  return boundaries[boundaries.length - 1] ?? t;
}

/** The last boundary strictly before t (or 0). */
export function prevBoundary(t, boundaries) {
  for (let i = boundaries.length - 1; i >= 0; i--) if (boundaries[i] < t - 0.01) return boundaries[i];
  return boundaries[0] ?? 0;
}

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

/** Labelled tick step (seconds) so labels are at least `minPx` apart, plus minor subdivisions. */
export function tickStep(pxPerSec, minPx = 72) {
  const major = TICK_STEPS.find((s) => s * pxPerSec >= minPx) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const minorDiv = major * pxPerSec >= 150 ? 10 : 5;
  return { major, minor: major / minorDiv };
}

/** Ruler label: 0:05, 1:30, or 0:02.50 when the step is below a second. */
export function formatTick(t, step) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (step < 1) return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`;
}

/** Precise clock: 0:07.25 */
export function formatClock(seconds) {
  const t = Math.max(0, seconds);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** Indices [lo, hi] of transcript items more than half inside `range`, or null. */
export function itemsInRange(items, range) {
  let lo = -1;
  let hi = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const len = it.end - it.start;
    if (len <= 0) continue;
    if (overlapLength(it, [range]) / len > 0.5) {
      if (lo < 0) lo = i;
      hi = i;
    }
  }
  return lo < 0 ? null : { lo, hi };
}

/** True when `range` is (all but) entirely covered by removedRanges. */
export function rangeIsRemoved(range, removedRanges) {
  const len = range.end - range.start;
  if (len <= 0) return false;
  return overlapLength(range, removedRanges) >= len - 1e-3;
}

/**
 * Move one edge of removedRanges[index] to t (already snapped), keeping it inside its
 * neighbours and at least `minLen` long. Returns the new list (unnormalized order kept).
 */
export function moveRangeEdge(removedRanges, index, edge, t, minLen = 0.05) {
  const r = removedRanges[index];
  if (!r) return removedRanges;
  const prevEnd = index > 0 ? removedRanges[index - 1].end : 0;
  const nextStart = index < removedRanges.length - 1 ? removedRanges[index + 1].start : Infinity;
  const next = { ...r };
  if (edge === 'start') next.start = Math.min(r.end - minLen, Math.max(prevEnd, t));
  else next.end = Math.max(r.start + minLen, Math.min(nextStart, t));
  return removedRanges.map((x, i) => (i === index ? next : x));
}