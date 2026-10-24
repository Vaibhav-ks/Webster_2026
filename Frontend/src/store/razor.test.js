// Razor (split a pause into pieces) at store level: split, delete one piece, undo/redo,
// selection stays on the right piece, and saved projects reopen with the pieces intact.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useEditorStore, getSelectionSpan } from './useEditorStore.js';
import { buildEDL } from '../lib/edl.js';

// "Hello world" ... 4 s pause ... "again"
const WORDS = [
  { id: 'w0', text: 'Hello', start: 0.0, end: 0.4 },
  { id: 'w1', text: 'world', start: 0.5, end: 1.0 },
  { id: 'w2', text: 'again', start: 5.0, end: 5.5 },
];

const s = () => useEditorStore.getState();
const gapItems = () => s().items.filter((i) => i.kind === 'gap');
const indexOf = (start) => s().items.findIndex((i) => Math.abs(i.start - start) < 1e-9);

beforeEach(() => {
  s().reset();
  useEditorStore.setState({ videoUrl: 'blob:test', duration: 6 });
  s().setTranscript(WORDS);
});

test('razor splits a pause into two tokens; nothing is cut yet', () => {
  assert.equal(gapItems().length, 1);
  assert.equal(s().addSplit(3), true);
  assert.deepEqual(gapItems().map((g) => [g.start, g.end]), [[1, 3], [3, 5]]);
  assert.deepEqual(s().removedRanges, []); // a split alone never changes the output
  assert.equal(s().past.length, 1); // but it is undoable
});

test('razor refuses words, gap edges and existing marks', () => {
  assert.equal(s().addSplit(0.2), false); // inside "Hello"
  assert.equal(s().addSplit(1.01), false); // too close to the end of "world"
  assert.equal(s().addSplit(3), true);
  assert.equal(s().addSplit(3.01), false); // too close to the existing mark
  assert.equal(s().past.length, 1);
});

test('split twice, delete the middle piece only (the Premiere workflow)', () => {
  s().addSplit(2);
  s().addSplit(4);
  assert.equal(gapItems().length, 3);
  const mid = indexOf(2);
  s().setSelection({ anchor: mid, focus: mid });
  const span = getSelectionSpan(s());
  s().removeRange(span.range);
  assert.deepEqual(s().removedRanges, [{ start: 2, end: 4 }]);
  assert.deepEqual(buildEDL(s().removedRanges, 6), [{ start: 0, end: 2 }, { start: 4, end: 6 }]);
  // The selection is still on the (now deleted) middle piece, so Delete again restores it.
  const after = getSelectionSpan(s());
  assert.deepEqual(after.range, { start: 2, end: 4 });
});

test('cutting the middle of a pause (no razor) also divides its token', () => {
  s().removeRange({ start: 2, end: 3 });
  assert.deepEqual(gapItems().map((g) => [g.start, g.end]), [[1, 2], [2, 3], [3, 5]]);
  // ...so the remaining pieces can be cut separately: the old "only once per pause" problem.
  s().removeRange({ start: 4, end: 5 });
  assert.equal(gapItems().length, 4);
});

test('undo and redo restore both the cuts and the razor marks', () => {
  s().addSplit(3); // step 1
  s().removeRange({ start: 3, end: 5 }); // step 2
  s().undo();
  assert.deepEqual(s().removedRanges, []);
  assert.deepEqual(s().splits, [3]);
  assert.equal(gapItems().length, 2);
  s().undo();
  assert.deepEqual(s().splits, []);
  assert.equal(gapItems().length, 1);
  s().redo();
  s().redo();
  assert.deepEqual(s().splits, [3]);
  assert.deepEqual(s().removedRanges, [{ start: 3, end: 5 }]);
});

test('reopening a saved project keeps the pieces that were cut', () => {
  // Saved projects store only removedRanges; the cut edge still divides the pause.
  s().loadEdits({ removedRanges: [{ start: 3, end: 5 }], past: [[]], future: [] });
  assert.deepEqual(gapItems().map((g) => [g.start, g.end]), [[1, 3], [3, 5]]);
  assert.equal(s().splitsPast.length, 1);
  s().undo();
  assert.deepEqual(s().removedRanges, []);
  assert.equal(gapItems().length, 1);
});
