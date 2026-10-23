// One-click filler removal: analyse -> review -> apply (one commit) -> undo.
//
// The review lives in store.fillerReview and is UI state only. Nothing touches
// removedRanges until applyFillerRemoval(), which adds every selected cut through the
// store's own commit(): one undo step, and the preview, timeline, transcript and
// exporter pick it up exactly like a manual cut.

import { useEditorStore } from './useEditorStore.js';
import { detectFillers, defaultSelection, buildFillerCuts } from '../lib/fillers.js';
import { normalize } from '../lib/ranges.js';
import { editedDuration, isSpanRemoved } from '../lib/edl.js';

const get = () => useEditorStore.getState();
const setReview = (review) => get().setFillerReview(review);
const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

/** Run the detector on the current transcript. `detect` is injectable for tests. */
export async function analyzeFillers({ detect = detectFillers } = {}) {
  const s = get();
  if (s.status !== 'ready' || s.fillerReview?.phase === 'analyzing') return;
  const videoUrl = s.videoUrl;
  setReview({ phase: 'analyzing' });
  await yieldToUI(); // let the "Analysing…" state paint before the synchronous work

  try {
    const { words, duration, energy, removedRanges } = get();
    const { candidates, audioUsed } = detect({ words, duration, energy });
    if (get().videoUrl !== videoUrl) return; // another video was opened meanwhile
    const annotated = candidates.map((c) => ({
      ...c,
      alreadyCut: c.cuttable && isSpanRemoved(c, removedRanges),
    }));
    setReview({ phase: 'review', candidates: annotated, selected: defaultSelection(annotated), audioUsed, error: null });
  } catch (err) {
    console.error('[fillers]', err);
    if (get().videoUrl !== videoUrl) return;
    setReview({ phase: 'error', error: `Filler analysis failed: ${err?.message ?? err}. No edits were made.` });
  }
}

export function toggleFillerCandidate(id) {
  const r = get().fillerReview;
  if (r?.phase !== 'review') return;
  const c = r.candidates.find((x) => x.id === id);
  if (!c?.cuttable) return;
  setReview({ ...r, selected: { ...r.selected, [id]: !r.selected[id] } });
}

/** Select or clear every cuttable candidate with one of `labels`. */
export function setFillerSelection(labels, on) {
  const r = get().fillerReview;
  if (r?.phase !== 'review') return;
  const selected = { ...r.selected };
  for (const c of r.candidates) if (labels.includes(c.label) && c.cuttable && !c.alreadyCut) selected[c.id] = on;
  setReview({ ...r, selected });
}

/** Commit the selected cuts as one edit. On any failure removedRanges is left untouched. */
export function applyFillerRemoval() {
  const s = get();
  const r = s.fillerReview;
  if (r?.phase !== 'review') return;
  try {
    const cuts = buildFillerCuts(r.candidates, r.selected, s.duration);
    if (!cuts.length) {
      setReview({ ...r, error: 'Nothing selected to remove.' });
      return;
    }
    const next = normalize([...s.removedRanges, ...cuts]);
    const saved = editedDuration(s.removedRanges, s.duration) - editedDuration(next, s.duration);
    const count = r.candidates.filter((c) => r.selected[c.id] && c.cuttable).length;
    s.commit(next);
    setReview({ ...r, phase: 'applied', error: null, applied: { ranges: next, count, saved } });
  } catch (err) {
    console.error('[fillers]', err);
    setReview({ ...r, error: `Could not apply the cuts: ${err?.message ?? err}. Nothing was changed.` });
  }
}

/** True while the last edit is still the filler removal (so a plain undo reverts exactly it). */
export function canUndoFillerRemoval(state = get()) {
  const r = state.fillerReview;
  return r?.phase === 'applied' && state.removedRanges === r.applied?.ranges && state.past.length > 0;
}

/** Undo the filler cuts and reopen the review with the same selection. */
export function undoFillerRemoval() {
  if (!canUndoFillerRemoval()) return;
  get().undo();
  const r = get().fillerReview;
  setReview({ ...r, phase: 'review', applied: null, error: null });
}

export function closeFillerReview() {
  setReview(null);
}