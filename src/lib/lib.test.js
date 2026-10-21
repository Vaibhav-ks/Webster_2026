// Run with: npm test   (uses Node's built-in test runner, no extra packages)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, addRange, subtractRange, complement, overlapLength, findRangeAt } from './ranges.js';
import { buildEDL, isSpanRemoved, editedDuration, nextPlayableTime, sourceToOutput, outputToSource } from './edl.js';
import { deriveGaps, buildTranscriptItems, findWordIndexAt } from './transcript.js';
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
