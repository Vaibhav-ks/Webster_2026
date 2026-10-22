import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeEditorState,
  serializeTranscript,
  prepareRestore,
  rangesAreValid,
  migrateEditorState,
  editorStateKey,
  titleFromFilename,
  HISTORY_LIMIT,
  SCHEMA_VERSION,
} from './projectState.js';
import { addRange, subtractRange } from '../lib/ranges.js';
import { buildEDL, isSpanRemoved, editedDuration } from '../lib/edl.js';
import { deriveGaps, buildTranscriptItems } from '../lib/transcript.js';

const words = [
  { id: 'w0', text: 'So', start: 0.2, end: 0.5 },
  { id: 'w1', text: 'um', start: 0.7, end: 1.0 },
  { id: 'w2', text: 'today', start: 1.1, end: 1.6 },
  { id: 'w3', text: 'we', start: 3.0, end: 3.2 },
  { id: 'w4', text: 'begin', start: 3.3, end: 3.9 },
];
const duration = 5;

/** Simulate an editing session with the store's own range functions. */
function session() {
  let removedRanges = [];
  const past = [];
  const commit = (next) => {
    past.push(removedRanges);
    removedRanges = next;
  };
  commit(addRange(removedRanges, { start: 0.7, end: 1.0 }));
  commit(addRange(removedRanges, { start: 1.6, end: 3.0 }));
  commit(subtractRange(removedRanges, { start: 2.0, end: 2.2 }));
  return { removedRanges, past, future: [[{ start: 0, end: 0.2 }]] };
}

test('save -> restore round trip reproduces the editor state and every derived view', () => {
  const s = session();
  const saved = JSON.parse(JSON.stringify({ editorState: serializeEditorState(s), transcript: serializeTranscript(words) }));

  const r = prepareRestore({
    words: saved.transcript.words,
    editorState: saved.editorState,
    schemaVersion: SCHEMA_VERSION,
    savedDuration: duration,
    loadedDuration: duration + 0.02,
  });
  assert.deepEqual(r.words, words);
  assert.deepEqual(r.removedRanges, s.removedRanges);
  assert.deepEqual(r.past, s.past);
  assert.deepEqual(r.future, s.future);
  assert.equal(r.historyDropped, false);

  // Transcript, timeline, preview and export all derive from these; they must agree.
  assert.deepEqual(buildEDL(r.removedRanges, duration), buildEDL(s.removedRanges, duration));
  assert.equal(editedDuration(r.removedRanges, duration), editedDuration(s.removedRanges, duration));
  const items = buildTranscriptItems(r.words, deriveGaps(r.words, duration));
  const deleted = items.filter((it) => isSpanRemoved(it, r.removedRanges)).map((it) => it.id);
  assert.ok(deleted.includes('w1'), 'deleted word is still deleted');
  assert.ok(!deleted.includes('w2'), 'kept word is still kept');
});

test('undo history is capped at the most recent 50 entries', () => {
  const past = Array.from({ length: 120 }, (_, i) => [{ start: i * 0.01, end: i * 0.01 + 0.005 }]);
  const out = serializeEditorState({ removedRanges: [], past, future: past });
  assert.equal(out.history.past.length, HISTORY_LIMIT);
  assert.deepEqual(out.history.past.at(-1), past.at(-1));
  assert.equal(out.history.future.length, HISTORY_LIMIT);
  assert.deepEqual(out.history.future[0], past[0]);
});

test('a damaged undo history is dropped; the project still opens', () => {
  const r = prepareRestore({
    words,
    editorState: { removedRanges: [{ start: 1, end: 2 }], history: { past: [[{ start: 3, end: 99 }]], future: 'nope' } },
    schemaVersion: 1,
    savedDuration: duration,
    loadedDuration: duration,
  });
  assert.deepEqual(r.removedRanges, [{ start: 1, end: 2 }]);
  assert.deepEqual(r.past, []);
  assert.deepEqual(r.future, []);
  assert.equal(r.historyDropped, true);
});

test('damaged cuts or transcript are refused, never silently reset', () => {
  const base = { words, schemaVersion: 1, savedDuration: duration, loadedDuration: duration };
  const bad = [
    { removedRanges: [{ start: 2, end: 1 }] },
    { removedRanges: [{ start: 1, end: 3 }, { start: 2, end: 4 }] },
    { removedRanges: [{ start: 1, end: 60 }] },
    { removedRanges: 'x' },
  ];
  for (const editorState of bad) {
    assert.throws(() => prepareRestore({ ...base, editorState }), (e) => e.code === 'EDITS_INVALID');
  }
  assert.throws(
    () => prepareRestore({ ...base, words: [{ id: 'w0', text: 'a', start: 1, end: 0 }], editorState: { removedRanges: [] } }),
    (e) => e.code === 'TRANSCRIPT_INVALID',
  );
});

test('a different video (duration) is refused before anything is loaded', () => {
  assert.throws(
    () =>
      prepareRestore({ words, editorState: { removedRanges: [] }, schemaVersion: 1, savedDuration: 5, loadedDuration: 7.5 }),
    (e) => e.code === 'SOURCE_MISMATCH',
  );
});

test('schema versions: current loads, newer is refused with a clear message', () => {
  assert.deepEqual(migrateEditorState({ removedRanges: [] }, 1), { removedRanges: [] });
  assert.throws(() => migrateEditorState({ removedRanges: [] }, SCHEMA_VERSION + 1), (e) => e.code === 'SCHEMA_NEWER');
  assert.throws(() => migrateEditorState({ removedRanges: [] }, 0), (e) => e.code === 'SCHEMA_UNKNOWN');
});

test('rangesAreValid accepts exactly what the store produces', () => {
  const s = session();
  assert.ok(rangesAreValid(s.removedRanges, duration));
  assert.ok(rangesAreValid([], duration));
  // Touching ranges would have been merged by normalize(), so they are not canonical.
  assert.ok(!rangesAreValid([{ start: 1, end: 2 }, { start: 2, end: 3 }], duration));
});

test('change detection ignores identical state and runtime extras', () => {
  const s = session();
  assert.equal(editorStateKey(s), editorStateKey({ ...s, removedRanges: s.removedRanges.map((r) => ({ ...r, extra: 1 })) }));
  assert.notEqual(editorStateKey(s), editorStateKey({ ...s, removedRanges: [] }));
});

test('titles come from the file name', () => {
  assert.equal(titleFromFilename('My Talk (final).mp4'), 'My Talk (final)');
  assert.equal(titleFromFilename(''), 'Untitled project');
});
