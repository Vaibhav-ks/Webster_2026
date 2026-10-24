// Run with: npm test   (uses Node's built-in test runner, no extra packages)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, addRange, subtractRange, complement, overlapLength, findRangeAt } from './ranges.js';
import { buildEDL, isSpanRemoved, editedDuration, nextPlayableTime, sourceToOutput, outputToSource } from './edl.js';
import { deriveGaps, buildTranscriptItems, findWordIndexAt, gapPieces, gapCutTimes, splitTarget } from './transcript.js';
import { snapCut } from './snap.js';
import { chunkAudio } from './chunkAudio.js';

const words = [
  { id: 'w0', text: 'Hello', start: 1.0, end: 1.4 },
  { id: 'w1', text: 'um', start: 1.5, end: 1.7 },
  { id: 'w2', text: 'world', start: 1.8, end: 2.2 },
  { id: 'w3', text: 'again', start: 5.0, end: 5.5 },
];
const duration = 6;

test('normalize merges overlapping and touching ranges', () => {
  assert.deepEqual(
    normalize([{ start: 3, end: 4 }, { start: 1, end: 2 }, { start: 2, end: 2.5 }, { start: 5, end: 5 }]),
    [{ start: 1, end: 2.5 }, { start: 3, end: 4 }],
  );
});

test('add then subtract splits a range', () => {
  const r = addRange([], { start: 1, end: 5 });
  assert.deepEqual(subtractRange(r, { start: 2, end: 3 }), [{ start: 1, end: 2 }, { start: 3, end: 5 }]);
  assert.deepEqual(subtractRange(r, { start: 0, end: 10 }), []);
});

test('complement gives the kept ranges', () => {
  assert.deepEqual(complement([{ start: 1, end: 2 }], 0, 3), [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
  assert.deepEqual(complement([], 0, 3), [{ start: 0, end: 3 }]);
  assert.deepEqual(complement([{ start: 0, end: 3 }], 0, 3), []);
});

test('overlap and lookup', () => {
  const rs = [{ start: 1, end: 2 }, { start: 4, end: 6 }];
  assert.equal(overlapLength({ start: 1.5, end: 4.5 }, rs), 1);
  assert.deepEqual(findRangeAt(rs, 4), { start: 4, end: 6 });
  assert.equal(findRangeAt(rs, 2), null); // end is exclusive
});

test('EDL, deleted words and edited duration', () => {
  const removed = addRange([], { start: words[1].start, end: words[1].end }); // delete "um"
  assert.deepEqual(buildEDL(removed, duration), [{ start: 0, end: 1.5 }, { start: 1.7, end: 6 }]);
  assert.equal(isSpanRemoved(words[1], removed), true);
  assert.equal(isSpanRemoved(words[0], removed), false);
  assert.ok(Math.abs(editedDuration(removed, duration) - 5.8) < 1e-9);
});

test('playback skips removed ranges and stops at a removed tail', () => {
  const removed = [{ start: 1, end: 2 }, { start: 5, end: 6 }];
  assert.equal(nextPlayableTime(0.5, removed, duration), 0.5);
  assert.equal(nextPlayableTime(1.2, removed, duration), 2);
  assert.equal(nextPlayableTime(5.5, removed, duration), null);
});

test('source <-> output time mapping', () => {
  const edl = buildEDL([{ start: 1, end: 2 }], duration);
  assert.equal(sourceToOutput(3, edl), 2);
  assert.equal(outputToSource(2, edl), 3);
});

test('gaps are spans longer than 0.5s, including intro and outro', () => {
  const gaps = deriveGaps(words, duration);
  // the 0.5 s outro (5.5 -> 6) is not longer than the threshold, so it is not a gap
  assert.deepEqual(gaps, [{ start: 0, end: 1 }, { start: 2.2, end: 5 }]);
  assert.deepEqual(deriveGaps([], 10), [{ start: 0, end: 10 }]);
});

test('transcript items interleave gaps and words in time order', () => {
  const items = buildTranscriptItems(words, deriveGaps(words, duration));
  assert.deepEqual(items.map((i) => i.id), ['gap-0', 'w0', 'w1', 'w2', 'gap-1', 'w3']);
  assert.equal(findWordIndexAt(words, 1.9), 2);
  assert.equal(findWordIndexAt(words, 1.45), -1);
});

test('snapCut: free inside gaps, word boundaries elsewhere, never crashes', () => {
  const gaps = deriveGaps(words, duration);
  assert.equal(snapCut(3.0, words, gaps), 3.0); // free inside long gap
  assert.equal(snapCut(2.21, words, gaps), 2.24); // padded away from the word edge
  assert.equal(snapCut(1.25, words, gaps), 1.4); // inside "Hello", nearer its end
  assert.equal(snapCut(1.05, words, gaps), 1.0); // inside "Hello", nearer its start
  assert.equal(snapCut(1.44, words, gaps), 1.4); // short gap between words: the SRS draft crashed here
});

test('chunkAudio cuts at the quietest point and covers all samples', () => {
  const sr = 100;
  const samples = new Float32Array(sr * 70).fill(0.5);
  samples.fill(0, sr * 25, sr * 25 + 10); // a silent spot at 25 s
  const chunks = chunkAudio(samples, sr, 29, 20);
  assert.equal(chunks[0].start, 0);
  assert.ok(Math.abs(chunks[0].end - sr * 25) <= 10);
  assert.equal(chunks[chunks.length - 1].end, samples.length);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].start, chunks[i - 1].end);
});

// ---- timeline ----
import {
  snapSeek, wordBoundaries, nextBoundary, prevBoundary, tickStep, formatTick,
  itemsInRange, rangeIsRemoved, moveRangeEdge,
} from './timeline.js';

test('snapSeek never lands inside a word', () => {
  const gaps = deriveGaps(words, duration);
  for (let t = 0; t <= duration; t += 0.01) {
    const s = snapSeek(t, words, gaps, duration);
    for (const w of words) assert.ok(!(s > w.start + 1e-9 && s < w.end - 1e-9), `t=${t} -> ${s} inside ${w.text}`);
  }
  assert.equal(snapSeek(1.1, words, gaps, duration), 1.0); // nearer the start
  assert.equal(snapSeek(1.35, words, gaps, duration), 1.4); // nearer the end
  assert.equal(snapSeek(3.3, words, gaps, duration), 3.3); // free inside a long silence
  assert.equal(snapSeek(-2, words, gaps, duration), 0);
});

test('word boundary stepping', () => {
  const b = wordBoundaries(words, duration);
  assert.deepEqual(b, [0, 1, 1.4, 1.5, 1.7, 1.8, 2.2, 5, 5.5, 6]);
  assert.equal(nextBoundary(1.0, b), 1.4);
  assert.equal(prevBoundary(1.0, b), 0);
  assert.equal(nextBoundary(6, b), 6);
});

test('tick step keeps labels apart', () => {
  assert.equal(tickStep(100).major, 1);
  assert.equal(tickStep(10).major, 10);
  assert.equal(formatTick(65, 5), '1:05');
  assert.equal(formatTick(2.5, 0.5), '0:02.50');
});

test('range selection helpers', () => {
  const items = buildTranscriptItems(words, deriveGaps(words, duration));
  const sel = itemsInRange(items, { start: 1.0, end: 1.7 });
  assert.equal(items[sel.lo].id, 'w0');
  assert.equal(items[sel.hi].id, 'w1');
  assert.equal(rangeIsRemoved({ start: 1, end: 2 }, [{ start: 0.5, end: 2.5 }]), true);
  assert.equal(rangeIsRemoved({ start: 1, end: 2 }, [{ start: 1.5, end: 2.5 }]), false);
  const moved = moveRangeEdge([{ start: 1, end: 2 }, { start: 3, end: 4 }], 0, 'end', 3.5);
  assert.deepEqual(moved[0], { start: 1, end: 3 }); // clamped to neighbour
});
test('gap pieces: a pause is divided at razor marks and cut edges inside it', () => {
  const gaps = [{ start: 1, end: 5 }];
  assert.deepEqual(gapPieces(gaps, []).map((p) => [p.start, p.end]), [[1, 5]]);
  assert.deepEqual(gapPieces(gaps, [3]).map((p) => [p.start, p.end]), [[1, 3], [3, 5]]);
  // edges and marks too close to an edge (or to each other) are ignored
  assert.deepEqual(gapPieces(gaps, [1, 1.01, 3, 3.02, 5]).map((p) => [p.start, p.end]), [[1, 3], [3, 5]]);
  assert.deepEqual(gapCutTimes([3], [{ start: 2, end: 4 }]), [2, 3, 4]);
});

test('split gap tokens keep their ids stable when unsplit', () => {
  const ws = [{ id: 'w0', text: 'a', start: 0, end: 1 }, { id: 'w1', text: 'b', start: 5, end: 6 }];
  const gaps = deriveGaps(ws, 6);
  assert.deepEqual(buildTranscriptItems(ws, gaps).map((i) => i.id), ['w0', 'gap-0', 'w1']);
  assert.deepEqual(buildTranscriptItems(ws, gaps, [3]).map((i) => i.id), ['w0', 'gap-0-0', 'gap-0-1', 'w1']);
});

test('splitTarget: only strictly inside a pause, never on a word', () => {
  const gaps = [{ start: 1, end: 5 }];
  assert.ok(splitTarget(3, gaps));
  assert.equal(splitTarget(0.5, gaps), null);
  assert.equal(splitTarget(1.01, gaps), null);
  assert.equal(splitTarget(3.01, gaps, [3]), null);
});
