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

/**
 * Words and gap tokens in time order, as rendered in the transcript.
 * Item: { kind: 'word' | 'gap', id, start, end, text? }
 */
export function buildTranscriptItems(words, gaps) {
  const items = [
    ...words.map((w) => ({ kind: 'word', ...w })),
    ...gaps.map((g, i) => ({ kind: 'gap', id: `gap-${i}`, start: g.start, end: g.end })),
  ];
  return items.sort((a, b) => a.start - b.start || (a.kind === 'gap' ? -1 : 1));
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
