// Pure helpers for lists of time ranges: [{ start, end }] in source seconds.
// A "normalized" list is sorted, non-overlapping and has no zero-length ranges.
// Every function returns a new array and never mutates its input.

export const EPS = 1e-4;

/** Sort, merge overlapping or touching ranges, and drop empty ones. */
export function normalize(ranges) {
  const sorted = ranges
    .filter((r) => r.end - r.start > EPS)
    .map((r) => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start);

  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPS) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push(r);
    }
  }
  return out;
}

/** Add a range (union). */
export function addRange(ranges, range) {
  return normalize([...ranges, range]);
}

/** Remove a range (difference). Ranges partly covered are trimmed or split. */
export function subtractRange(ranges, range) {
  const out = [];
  for (const r of ranges) {
    if (range.end <= r.start || range.start >= r.end) {
      out.push({ ...r });
      continue;
    }
    if (range.start > r.start) out.push({ start: r.start, end: range.start });
    if (range.end < r.end) out.push({ start: range.end, end: r.end });
  }
  return normalize(out);
}

/** Everything in [from, to] that is NOT covered by `ranges`. Input must be normalized. */
export function complement(ranges, from, to) {
  const out = [];
  let cursor = from;
  for (const r of ranges) {
    if (r.end <= from || r.start >= to) continue;
    if (r.start > cursor) out.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (to > cursor) out.push({ start: cursor, end: to });
  return out.filter((r) => r.end - r.start > EPS);
}

/** Total length of `span` that lies inside `ranges`. */
export function overlapLength(span, ranges) {
  let total = 0;
  for (const r of ranges) {
    const s = Math.max(span.start, r.start);
    const e = Math.min(span.end, r.end);
    if (e > s) total += e - s;
  }
  return total;
}

/** The range containing time t (start inclusive, end exclusive), or null. Binary search. */
export function findRangeAt(ranges, t) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (t < r.start) hi = mid - 1;
    else if (t >= r.end) lo = mid + 1;
    else return r;
  }
  return null;
}

export function totalLength(ranges) {
  return ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
}
