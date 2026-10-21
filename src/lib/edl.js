// Edit Decision List: everything derived from removedRanges.
// The preview and the exporter must both use these functions so they can never disagree.

import { complement, overlapLength, findRangeAt, totalLength } from './ranges.js';
import { DELETE_OVERLAP } from './config.js';

/** The ordered list of source ranges that are kept (SRS §1.3). */
export function buildEDL(removedRanges, duration) {
  return complement(removedRanges, 0, duration);
}

/** A word or gap is deleted when more than DELETE_OVERLAP of it is removed (SRS §3.1). */
export function isSpanRemoved(span, removedRanges, threshold = DELETE_OVERLAP) {
  const len = span.end - span.start;
  if (len <= 0) return false;
  return overlapLength(span, removedRanges) / len > threshold;
}

/** Length of the edited video in seconds. */
export function editedDuration(removedRanges, duration) {
  return totalLength(buildEDL(removedRanges, duration));
}

/**
 * Where playback should be for source time t: t itself if kept, otherwise the end of
 * the removed range it falls in. removedRanges is normalized, so one hop is enough.
 * Returns null when everything after t is removed.
 */
export function nextPlayableTime(t, removedRanges, duration) {
  const r = findRangeAt(removedRanges, t);
  if (!r) return t;
  return r.end >= duration - 1e-3 ? null : r.end;
}

/** Map a source time to its position in the edited (output) timeline. */
export function sourceToOutput(t, edl) {
  let out = 0;
  for (const k of edl) {
    if (t < k.start) return out;
    if (t <= k.end) return out + (t - k.start);
    out += k.end - k.start;
  }
  return out;
}

/** Map an output-timeline time back to a source time. */
export function outputToSource(t, edl) {
  let acc = 0;
  for (const k of edl) {
    const len = k.end - k.start;
    if (t <= acc + len) return k.start + (t - acc);
    acc += len;
  }
  return edl.length ? edl[edl.length - 1].end : 0;
}
