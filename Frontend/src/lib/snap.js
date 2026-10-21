// Cut snapping for timeline mode (SRS §3.3). Every timeline action passes its
// timestamp through snapCut before touching state; the data model accepts any range.

import { CUT_PAD } from './config.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * - Inside a gap (> threshold, no speech): free cut, kept `pad` away from the gap edges.
 * - Anywhere else (inside a word, or in a short gap between words): snap to the
 *   nearest word boundary, so a cut can never land inside a word.
 *
 * Fix vs the SRS draft: the draft looked only for the word containing t, so a cut in a
 * short gap between two words found no word and crashed. Snapping to the nearest
 * boundary of any word covers both cases.
 */
export function snapCut(t, words, gaps, pad = CUT_PAD) {
  const gap = gaps.find((g) => t >= g.start && t <= g.end);
  if (gap) {
    if (gap.end - gap.start <= 2 * pad) return (gap.start + gap.end) / 2;
    return clamp(t, gap.start + pad, gap.end - pad);
  }
  if (!words.length) return t;

  let best = words[0].start;
  for (const w of words) {
    if (Math.abs(w.start - t) < Math.abs(best - t)) best = w.start;
    if (Math.abs(w.end - t) < Math.abs(best - t)) best = w.end;
    if (w.start > t + Math.abs(best - t)) break; // sorted: nothing closer later
  }
  return best;
}
