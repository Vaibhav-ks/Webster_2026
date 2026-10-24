// Gaps (non-speech stretches) and the combined list of transcript items.

import { GAP_THRESHOLD } from './config.js';

/**
 * Spans between words (and before the first / after the last word) longer than
 * the threshold. Derived from words, never stored as edit state (SRS §3.3).
 * `words` must be sorted by start time.
 */
export function deriveGaps(words, duration, threshold = GAP_THRESHOLD) {
  const gaps = [];
  let prevEnd = 0;
  for (const w of words) {
    if (w.start - prevEnd > threshold) gaps.push({ start: prevEnd, end: w.start });
    prevEnd = Math.max(prevEnd, w.end);
  }
  if (duration - prevEnd > threshold) gaps.push({ start: prevEnd, end: duration });
  return gaps;
}

/** Gap pieces shorter than this are not created (a razor mark this close to an edge is ignored). */
export const MIN_GAP_PIECE = 0.05;

/**
 * Times at which gaps are divided into separate pieces: razor marks (`splits`) plus
 * every cut edge (removedRanges start/end) that falls inside a gap. So cutting the
 * middle out of a pause shows it as kept / removed / kept, each selectable on its own.
 */
export function gapCutTimes(splits, removedRanges) {
  const times = [...splits];
  for (const r of removedRanges) times.push(r.start, r.end);
  return times.sort((a, b) => a - b);
}

/**
 * Divide each gap at the cut times strictly inside it.
 * Returns [{ gapIndex, piece, start, end }]. A gap with no cut inside stays one piece.
 */
export function gapPieces(gaps, cutTimes = [], minPiece = MIN_GAP_PIECE) {
  const out = [];
  gaps.forEach((g, gapIndex) => {
    const inner = [];
    for (const t of cutTimes) {
      if (t - g.start < minPiece || g.end - t < minPiece) continue;
      if (inner.length && t - inner[inner.length - 1] < minPiece) continue;
      inner.push(t);
    }
    const edges = [g.start, ...inner, g.end];
    for (let piece = 0; piece < edges.length - 1; piece++) {
      out.push({ gapIndex, piece, pieces: edges.length - 1, start: edges[piece], end: edges[piece + 1] });
    }
  });
  return out;
}

/**
 * Words and gap tokens in time order, as rendered in the transcript.
 * Item: { kind: 'word' | 'gap', id, start, end, text? }
 * With `cutTimes` (see gapCutTimes) a gap becomes several tokens: gap-3-0, gap-3-1, ...
 */
export function buildTranscriptItems(words, gaps, cutTimes = []) {
  const items = [
    ...words.map((w) => ({ kind: 'word', ...w })),
    ...gapPieces(gaps, cutTimes).map((p) => ({
      kind: 'gap',
      id: p.pieces === 1 ? `gap-${p.gapIndex}` : `gap-${p.gapIndex}-${p.piece}`,
      start: p.start,
      end: p.end,
    })),
  ];
  return items.sort((a, b) => a.start - b.start || (a.kind === 'gap' ? -1 : 1));
}

/**
 * Where a razor click may split: strictly inside a gap, at least `minPiece` from its
 * edges and from every existing cut time. Returns the gap or null. Words can never be split.
 */
export function splitTarget(t, gaps, cutTimes = [], minPiece = MIN_GAP_PIECE) {
  const gap = gaps.find((g) => t - g.start >= minPiece && g.end - t >= minPiece);
  if (!gap) return null;
  if (cutTimes.some((c) => Math.abs(c - t) < minPiece)) return null;
  return gap;
}

/** Index of the word playing at time t, or -1. `words` sorted by start. */
export function findWordIndexAt(words, t) {
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid];
    if (t < w.start) hi = mid - 1;
    else if (t >= w.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function formatTime(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Label for a gap token, e.g. "pause 0.8s" or "no speech 1:40". */
export function gapLabel(gap) {
  const len = gap.end - gap.start;
  return len < 3 ? `pause ${len.toFixed(1)}s` : `no speech ${formatTime(len)}`;
}
