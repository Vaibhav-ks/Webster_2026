// Store-level flow for one-click filler removal: analyse -> exclude -> apply -> undo,
// plus failure recovery. Runs the real Zustand store in Node (no DOM needed).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useEditorStore } from './useEditorStore.js';
import {
  analyzeFillers,
  toggleFillerCandidate,
  setFillerSelection,
  applyFillerRemoval,
  undoFillerRemoval,
  canUndoFillerRemoval,
} from './fillerActions.js';
import { buildEDL } from '../lib/edl.js';

const WORDS = [
  { id: 'w0', text: 'So', start: 0.5, end: 0.8 },
  { id: 'w1', text: 'um', start: 0.9, end: 1.2 },
  { id: 'w2', text: 'I', start: 1.3, end: 1.4 },
  { id: 'w3', text: 'I', start: 1.5, end: 1.6 },
  { id: 'w4', text: 'like', start: 1.7, end: 1.9 },
  { id: 'w5', text: 'programming.', start: 2.0, end: 2.6 },
  { id: 'w6', text: 'Uh,', start: 3.0, end: 3.3 },
  { id: 'w7', text: 'thanks.', start: 3.4, end: 3.9 },
];

function load() {
  const s = useEditorStore.getState();
  s.reset();
  useEditorStore.setState({ videoUrl: 'blob:test', duration: 5 });
  useEditorStore.getState().setTranscript(WORDS);
}

beforeEach(load);

test('analyse pre-selects only confident fillers; "like" in "I like programming" is kept', async () => {
  await analyzeFillers();
  const r = useEditorStore.getState().fillerReview;
  assert.equal(r.phase, 'review');
  const byText = Object.fromEntries(r.candidates.map((c) => [c.text, c]));
  assert.equal(r.selected[byText['um'].id], true);
  assert.equal(r.selected[byText['Uh,'].id], true);
  assert.equal(r.selected[byText['I'].id], true); // "I I"
  assert.equal(byText['like'].label, 'KEEP');
  assert.notEqual(r.selected[byText['like'].id], true);
  assert.deepEqual(useEditorStore.getState().removedRanges, [], 'analysis alone must not edit');
});

test('apply commits one edit; excluded candidates are not cut; undo restores', async () => {
  await analyzeFillers();
  let r = useEditorStore.getState().fillerReview;
  const uh = r.candidates.find((c) => c.text === 'Uh,');
  toggleFillerCandidate(uh.id); // user excludes "Uh,"
  const pastBefore = useEditorStore.getState().past.length;

  applyFillerRemoval();
  const s = useEditorStore.getState();
  assert.equal(s.fillerReview.phase, 'applied');
  assert.equal(s.past.length, pastBefore + 1, 'exactly one undo step');
  assert.ok(s.removedRanges.some((x) => x.start <= 0.9 && x.end >= 1.2), '"um" is cut');
  assert.ok(!s.removedRanges.some((x) => x.end > uh.start && x.start < uh.end), 'excluded "Uh," is not cut');
  // the export EDL is derived from the same ranges
  assert.ok(buildEDL(s.removedRanges, 5).every((k) => k.end <= 0.9 || k.start >= 1.2));

  assert.equal(canUndoFillerRemoval(), true);
  undoFillerRemoval();
  r = useEditorStore.getState().fillerReview;
  assert.deepEqual(useEditorStore.getState().removedRanges, []);
  assert.equal(r.phase, 'review');
  assert.equal(r.selected[uh.id], false, 'selection is kept for another try');
});

test('after another edit, the panel does not claim it can undo the filler cuts', async () => {
  await analyzeFillers();
  applyFillerRemoval();
  useEditorStore.getState().removeRange({ start: 4.0, end: 4.5 });
  assert.equal(canUndoFillerRemoval(), false);
  const before = useEditorStore.getState().removedRanges;
  undoFillerRemoval(); // no-op
  assert.equal(useEditorStore.getState().removedRanges, before);
});

test('existing manual cuts are kept and merged', async () => {
  useEditorStore.getState().removeRange({ start: 1.1, end: 1.3 }); // clips the end of "um"
  await analyzeFillers();
  applyFillerRemoval();
  const rr = useEditorStore.getState().removedRanges;
  for (let i = 1; i < rr.length; i++) assert.ok(rr[i].start > rr[i - 1].end, 'normalized, no overlaps');
  assert.ok(rr.some((x) => x.start <= 0.9 && x.end >= 1.3));
});

test('a filler the user already cut is marked and not pre-selected', async () => {
  useEditorStore.getState().removeRange({ start: 0.9, end: 1.2 }); // "um" cut by hand
  await analyzeFillers();
  const r = useEditorStore.getState().fillerReview;
  const um = r.candidates.find((c) => c.text === 'um');
  assert.equal(um.alreadyCut, true);
  assert.notEqual(r.selected[um.id], true);
});

test('a failing detector leaves the edit state untouched and reports an error', async () => {
  useEditorStore.getState().removeRange({ start: 4.0, end: 4.5 });
  const before = useEditorStore.getState().removedRanges;
  await analyzeFillers({
    detect: () => {
      throw new Error('boom');
    },
  });
  const s = useEditorStore.getState();
  assert.equal(s.fillerReview.phase, 'error');
  assert.match(s.fillerReview.error, /No edits were made/);
  assert.equal(s.removedRanges, before);

  // recovery: a retry works normally
  await analyzeFillers();
  assert.equal(useEditorStore.getState().fillerReview.phase, 'review');
});

test('malformed candidates are skipped at apply time, valid ones still applied', async () => {
  await analyzeFillers({
    detect: () => ({
      audioUsed: false,
      candidates: [
        { id: 'ok', label: 'FILLER', cuttable: true, start: 0.9, end: 1.2, wordIds: ['w1'], text: 'um', reasons: [] },
        { id: 'bad', label: 'FILLER', cuttable: true, start: NaN, end: 2, wordIds: [], text: '?', reasons: [] },
        { id: 'out', label: 'FILLER', cuttable: true, start: 7, end: 8, wordIds: [], text: '?', reasons: [] },
      ],
    }),
  });
  applyFillerRemoval();
  assert.deepEqual(useEditorStore.getState().removedRanges, [{ start: 0.9, end: 1.2 }]);
});

test('nothing selected -> no commit, a message instead', async () => {
  await analyzeFillers();
  setFillerSelection(['FILLER', 'UNCERTAIN', 'KEEP'], false);
  const past = useEditorStore.getState().past.length;
  applyFillerRemoval();
  const s = useEditorStore.getState();
  assert.equal(s.past.length, past);
  assert.equal(s.fillerReview.phase, 'review');
  assert.match(s.fillerReview.error, /Nothing selected/);
});

test('loading a new transcript closes any open review', async () => {
  await analyzeFillers();
  useEditorStore.getState().setTranscript(WORDS);
  assert.equal(useEditorStore.getState().fillerReview, null);
});