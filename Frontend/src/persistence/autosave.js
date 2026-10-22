// Debounced autosave of the editor's cut list + undo history, only for a project the
// user explicitly saved. It watches the editor store; it never writes to it.
//
// - One request at a time; edits made while a save is in flight are sent right after.
// - Every save carries the revision it was based on. If the server has a newer one
//   (another tab / device saved), nothing is overwritten: the user chooses.
// - Network failures retry with backoff; the edits stay in the editor meanwhile.
// - Loading a different video, starting a new one, or signing out detaches the project
//   so autosave can never write one video's edits into another project.

import { useEditorStore } from '../store/useEditorStore.js';
import { useProjectStore } from '../account/useProjectStore.js';
import { useAuthStore } from '../account/useAuthStore.js';
import { api } from '../account/api.js';
import { serializeEditorState, editorStateKey } from './projectState.js';

const DEBOUNCE_MS = 2000;
const RETRY_MS = [5000, 15000, 60000];

let timer = null;
let inFlight = null;
let again = false;
let retries = 0;
let initialized = false;

const editorSnapshot = () => {
  const { removedRanges, past, future } = useEditorStore.getState();
  return { removedRanges, past, future };
};

export function currentKey() {
  return editorStateKey(editorSnapshot());
}

function schedule(ms = DEBOUNCE_MS) {
  clearTimeout(timer);
  timer = setTimeout(() => void saveNow(), ms);
}

export function cancelScheduledSave() {
  clearTimeout(timer);
  timer = null;
}

/** True if there are edits the server hasn't accepted yet (or an upload is unfinished). */
export function hasUnsavedWork() {
  const p = useProjectStore.getState();
  if (p.job && ['hash', 'create', 'upload', 'finalize'].includes(p.job.phase)) return true;
  if (!p.projectId) return false;
  return p.lastSavedKey !== currentKey();
}

function markDirty() {
  const p = useProjectStore.getState();
  if (!p.projectId) return;
  if (p.save.state === 'conflict') return; // wait for the user's decision
  if (currentKey() === p.lastSavedKey) {
    if (p.save.state !== 'saved') p.setSave({ state: 'saved', error: null });
    return;
  }
  if (p.save.state !== 'saving') p.setSave({ state: 'dirty' });
  schedule();
}

/** Send the latest editor state now. Safe to call any time; coalesces concurrent calls. */
export async function saveNow() {
  cancelScheduledSave();
  if (inFlight) {
    again = true;
    return inFlight;
  }
  const p = useProjectStore.getState();
  if (!p.projectId || p.save.state === 'conflict') return;
  if (useAuthStore.getState().status !== 'authenticated') return;
  const snapshot = editorSnapshot();
  const key = editorStateKey(snapshot);
  if (key === p.lastSavedKey) {
    p.setSave({ state: 'saved', error: null });
    return;
  }

  const projectId = p.projectId;
  p.setSave({ state: 'saving', error: null });
  inFlight = (async () => {
    try {
      const res = await api(`/projects/${projectId}`, {
        method: 'PATCH',
        body: { baseRevision: p.revision, editorState: serializeEditorState(snapshot) },
      });
      if (useProjectStore.getState().projectId !== projectId) return; // detached meanwhile
      retries = 0;
      useProjectStore.setState({ revision: res.revision, lastSavedKey: key });
      useProjectStore.getState().setSave({ state: 'saved', error: null, lastSavedAt: Date.now() });
    } catch (err) {
      if (useProjectStore.getState().projectId !== projectId) return;
      const ps = useProjectStore.getState();
      if (err.code === 'REVISION_CONFLICT') {
        ps.setSave({ state: 'conflict', error: 'This project was changed in another tab or on another device.' });
      } else if (err.status === 404) {
        ps.setSave({ state: 'error', error: 'This project no longer exists in your account. Your edits are still here.' });
        ps.detach();
      } else if (err.status === 401) {
        ps.setSave({ state: 'error', error: 'Sign in again to keep saving. Your edits are still here.' });
      } else {
        ps.setSave({ state: 'error', error: err.message || 'Saving failed.' });
        if (err.status === 0 || err.status >= 500) schedule(RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]);
      }
    }
  })().finally(() => {
    inFlight = null;
    if (again) {
      again = false;
      markDirty();
    }
  });
  return inFlight;
}

/** Wait for any save that is already running (used before checkpoints / restores). */
export async function settle() {
  cancelScheduledSave();
  while (inFlight) await inFlight;
}

export function initAutosave() {
  if (initialized) return;
  initialized = true;

  useEditorStore.subscribe((s, prev) => {
    const p = useProjectStore.getState();
    if (!p.projectId) return;
    if (s.file !== prev.file && s.file !== p.attachedFile) {
      // A different video (or none) is in the editor now.
      cancelScheduledSave();
      p.detach();
      return;
    }
    if (s.status !== 'ready') return;
    if (s.removedRanges !== prev.removedRanges || s.past !== prev.past || s.future !== prev.future) markDirty();
  });

  useAuthStore.subscribe((s, prev) => {
    const p = useProjectStore.getState();
    if (!p.projectId) return;
    if (s.status === 'guest' && prev.status === 'authenticated') {
      // Session ended (expired or revoked): pause. The edits stay in the editor and
      // saving resumes if the same person signs in again. (Explicit sign-out detaches.)
      cancelScheduledSave();
      p.setSave({ state: 'error', error: 'You were signed out. Sign in again to keep saving; your edits are still here.' });
    }
    if (s.status === 'authenticated' && s.user?.id !== prev.user?.id) {
      if (p.ownerId !== s.user?.id) {
        cancelScheduledSave();
        p.detach(); // a different account must never write into this project
        return;
      }
      if (p.save.state === 'error' || p.save.state === 'dirty') markDirty();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedWork()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
