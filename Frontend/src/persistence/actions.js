// User-level actions for saved projects. Each one reports progress through
// useProjectStore.job so the dialogs can show it, and none of them ever clears or
// rewrites the user's active edits on failure.

import { useEditorStore } from '../store/useEditorStore.js';
import { useProjectStore } from '../account/useProjectStore.js';
import { useAuthStore } from '../account/useAuthStore.js';
import { api } from '../account/api.js';
import { serializeEditorState, serializeTranscript, editorStateKey, RestoreError } from './projectState.js';
import { hashFile, uploadSource, abortUpload, downloadSource, mimeTypeOf, SourceError } from './sourceTransfer.js';
import { loadSavedProject } from './restoreProject.js';
import { saveNow, settle, currentKey, hasUnsavedWork } from './autosave.js';

export const MAX_UPLOAD_BYTES = Number(import.meta.env?.VITE_MAX_UPLOAD_MB || 2048) * 1024 * 1024;

const ps = () => useProjectStore.getState();
const userId = () => useAuthStore.getState().user?.id ?? null;
let controller = null;

function setJob(job) {
  ps().setJob(job);
}
const isAbort = (err) => err?.name === 'AbortError';

export function cancelJob() {
  controller?.abort();
}

// ------------------------------------------------------------------ first save
/**
 * Save the open session to the user's account: fingerprint the original video, create
 * the project (transcript + cuts), upload the original straight to private storage,
 * and let the server verify it. Autosave starts as soon as the project exists, so
 * edits made during a long upload are kept too.
 */
export async function saveNewProject({ title }) {
  const ed = useEditorStore.getState();
  const file = ed.file;
  if (!file || ed.status !== 'ready') return;
  if (file.size > MAX_UPLOAD_BYTES) {
    setJob({ kind: 'save', phase: 'error', error: `Videos up to ${Math.round(MAX_UPLOAD_BYTES / 1024 ** 2)} MB can be saved.` });
    return;
  }
  controller = new AbortController();
  const { signal } = controller;
  try {
    setJob({ kind: 'save', phase: 'create', progress: 0 });
    // The active storage (S3, Cloudinary ...) may have a lower limit than the app default.
    const health = await api('/health', { auth: false, signal }).catch(() => null);
    if (health && !health.storage) throw new Error("Saving videos isn't enabled on this server yet.");
    const limit = health?.storage?.maxBytes ?? MAX_UPLOAD_BYTES;
    if (file.size > limit) throw new Error(`This storage accepts videos up to ${Math.round(limit / 1024 ** 2)} MB.`);

    setJob({ kind: 'save', phase: 'hash', progress: 0 });
    const sha256 = await hashFile(file, { signal, onProgress: (progress) => setJob({ kind: 'save', phase: 'hash', progress }) });
    if (useEditorStore.getState().file !== file) throw new Error('A different video was opened. Nothing was saved.');

    setJob({ kind: 'save', phase: 'create', progress: 0 });
    const cur = useEditorStore.getState();
    const snapshot = { removedRanges: cur.removedRanges, past: cur.past, future: cur.future };
    const { project } = await api('/projects', {
      method: 'POST',
      signal,
      body: {
        title,
        transcript: serializeTranscript(cur.words),
        editorState: serializeEditorState(snapshot),
        source: {
          filename: file.name,
          mimeType: mimeTypeOf(file),
          sizeBytes: file.size,
          durationS: cur.duration,
          width: cur.videoWidth || null,
          height: cur.videoHeight || null,
          sha256,
        },
      },
    });
    ps().attach({ project, file, lastSavedKey: editorStateKey(snapshot), ownerId: userId() });
    if (currentKey() !== editorStateKey(snapshot)) void saveNow();

    await finishUpload({ project, file, signal });
  } catch (err) {
    if (isAbort(err)) {
      const id = ps().projectId;
      if (id) await abortUpload(id);
      setJob({ kind: 'save', phase: 'cancelled' });
    } else {
      setJob({ kind: 'save', phase: 'error', error: err.message || 'Saving failed.' });
    }
  } finally {
    controller = null;
  }
}

async function finishUpload({ project, file, signal, reupload = false }) {
  setJob({ kind: 'save', phase: 'upload', progress: 0, projectId: project.id });
  const done = await uploadSource({
    projectId: project.id,
    file,
    reupload,
    signal,
    onProgress: (progress) => setJob({ kind: 'save', phase: 'upload', progress, projectId: project.id }),
  });
  if (ps().projectId === project.id) ps().updateProject(done);
  setJob({ kind: 'save', phase: 'done', projectId: project.id });
  ps().showToast('Project saved to your account.', 'success');
}

/** Resume an interrupted upload for the attached project (same file still in the editor). */
export async function resumeUpload({ reupload = false } = {}) {
  const p = ps();
  const file = useEditorStore.getState().file;
  if (!p.projectId || !file || file !== p.attachedFile) return;
  controller = new AbortController();
  try {
    await finishUpload({ project: { id: p.projectId }, file, signal: controller.signal, reupload });
  } catch (err) {
    setJob(isAbort(err) ? { kind: 'save', phase: 'cancelled' } : { kind: 'save', phase: 'error', error: err.message, projectId: p.projectId });
  } finally {
    controller = null;
  }
}

// ------------------------------------------------------------------ explicit save
/** The Save button on an already-saved project: write the latest state and checkpoint it. */
export async function saveVersion() {
  const p = ps();
  if (!p.projectId) return;
  if (!p.restorable) return resumeUpload();
  await settle();
  const cur = useEditorStore.getState();
  const snapshot = { removedRanges: cur.removedRanges, past: cur.past, future: cur.future };
  p.setSave({ state: 'saving', error: null });
  try {
    const res = await api(`/projects/${p.projectId}/versions`, {
      method: 'POST',
      body: { baseRevision: ps().revision, editorState: serializeEditorState(snapshot), changeSummary: 'Saved' },
    });
    useProjectStore.setState({
      revision: res.revision,
      lastSavedKey: editorStateKey(snapshot),
      currentVersion: res.version?.versionNumber ?? ps().currentVersion,
    });
    ps().setSave({ state: 'saved', error: null, lastSavedAt: Date.now() });
    ps().showToast(res.unchanged ? 'Already saved. No changes since the last version.' : `Saved as version ${res.version.versionNumber}.`, 'success');
    if (currentKey() !== editorStateKey(snapshot)) void saveNow();
  } catch (err) {
    if (err.code === 'REVISION_CONFLICT') ps().setSave({ state: 'conflict', error: 'This project was changed somewhere else.' });
    else ps().setSave({ state: 'error', error: err.message });
  }
}

// ------------------------------------------------------------------ conflicts
/** 'overwrite': keep what's in this editor. 'reload': take the saved cuts (undoable). */
export async function resolveConflict(choice) {
  const p = ps();
  if (!p.projectId) return;
  try {
    const detail = await api(`/projects/${p.projectId}`);
    if (choice === 'reload') {
      const saved = detail.editorState.removedRanges.map((r) => ({ start: r.start, end: r.end }));
      useEditorStore.getState().commit(saved); // undo brings this tab's version back
    }
    useProjectStore.setState({ revision: detail.project.revision, lastSavedKey: null });
    p.setSave({ state: 'dirty', error: null });
    p.closeDialog();
    await saveNow();
  } catch (err) {
    p.setSave({ state: 'conflict', error: err.message });
  }
}

// ------------------------------------------------------------------ opening
/** True when opening another project would discard work that isn't saved anywhere. */
export function openWouldDiscardWork() {
  const ed = useEditorStore.getState();
  if (!ed.videoUrl) return false;
  if (!ps().projectId) return true; // guest / unsaved session
  return hasUnsavedWork();
}

export async function openProject(projectId) {
  controller = new AbortController();
  const { signal } = controller;
  try {
    setJob({ kind: 'open', phase: 'load', projectId });
    const detail = await api(`/projects/${projectId}?open=1`, { signal });
    if (!detail.project.restorable) {
      setJob(null);
      ps().openDialog('recovery', { recovery: { projectId, detail, mode: 'draft', reason: 'The original video upload was never finished.' } });
      return;
    }
    let file;
    try {
      file = await downloadSource(projectId, {
        signal,
        onPhase: (phase) => setJob({ kind: 'open', phase, progress: 0, projectId }),
        onProgress: (progress) => setJob({ ...ps().job, progress }),
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      if (err instanceof SourceError) {
        setJob(null);
        ps().openDialog('recovery', { recovery: { projectId, detail, mode: 'missing', code: err.code, reason: err.message } });
        return;
      }
      throw err;
    }
    await loadIntoEditor({ file, detail });
  } catch (err) {
    setJob(isAbort(err) ? null : { kind: 'open', phase: 'error', error: err.message, projectId });
  } finally {
    controller = null;
  }
}

async function loadIntoEditor({ file, detail }) {
  setJob({ kind: 'open', phase: 'restore', projectId: detail.project.id });
  ps().detach();
  const { historyDropped } = await loadSavedProject({ file, detail });
  ps().attach({ project: detail.project, file, lastSavedKey: currentKey(), ownerId: userId() });
  setJob(null);
  ps().closeDialog();
  ps().showToast(
    historyDropped
      ? `Opened “${detail.project.title}”. Undo history couldn't be restored, so it starts fresh.`
      : `Opened “${detail.project.title}”.`,
    historyDropped ? 'warn' : 'success',
  );
}

// ------------------------------------------------------------------ recovery
/**
 * The user picked a file from their device for a project whose cloud copy is missing,
 * damaged or was never finished. Only the identical file (same SHA-256) is accepted.
 */
export async function relinkAndOpen(file) {
  const rec = ps().recovery;
  if (!rec) return;
  const src = rec.detail.project.source;
  controller = new AbortController();
  const { signal } = controller;
  try {
    if (file.size !== src.sizeBytes) {
      throw new RestoreError('RELINK_MISMATCH', 'This is a different file (its size does not match). A different video needs a new project.');
    }
    setJob({ kind: 'relink', phase: 'verify', progress: 0 });
    const sha256 = await hashFile(file, { signal, onProgress: (progress) => setJob({ kind: 'relink', phase: 'verify', progress }) });
    if (sha256 !== src.sha256) {
      throw new RestoreError('RELINK_MISMATCH', 'This is not the original video (its fingerprint does not match). A different video needs a new project.');
    }
    await loadIntoEditor({ file, detail: rec.detail });
    // Put the original back in the cloud so the project is restorable everywhere again.
    controller = new AbortController();
    try {
      await finishUpload({ project: rec.detail.project, file, signal: controller.signal, reupload: rec.mode === 'missing' });
    } catch (err) {
      // The download failed for another reason (e.g. network) but the cloud copy is intact.
      if (err.code !== 'ALREADY_UPLOADED') throw err;
      setJob(null);
    }
  } catch (err) {
    if (isAbort(err)) setJob(null);
    else if (ps().projectId && ps().job?.phase === 'upload') {
      setJob({ kind: 'save', phase: 'error', error: err.message, projectId: ps().projectId });
      ps().showToast(`Opened from this device, but re-uploading the original failed: ${err.message}`, 'error');
    } else setJob({ kind: 'relink', phase: 'error', error: err.message });
  } finally {
    controller = null;
  }
}

// ------------------------------------------------------------------ versions
export async function restoreVersion(version) {
  const p = ps();
  if (!p.projectId) return;
  await settle();
  if (hasUnsavedWork()) await saveNow();
  if (ps().save.state === 'conflict') return;
  try {
    const res = await api(`/projects/${p.projectId}/versions/${version.id}/restore`, {
      method: 'POST',
      body: { baseRevision: ps().revision },
    });
    // Through the editor's own commit(): the previous cuts stay one Undo away.
    useEditorStore.getState().commit(res.editorState.removedRanges);
    useProjectStore.setState({ revision: res.revision, lastSavedKey: currentKey(), currentVersion: res.version.versionNumber });
    ps().setSave({ state: 'saved', error: null, lastSavedAt: Date.now() });
    ps().showToast(`Restored version ${version.versionNumber} (saved as version ${res.version.versionNumber}).`, 'success');
    if (currentKey() !== ps().lastSavedKey) void saveNow();
    return true;
  } catch (err) {
    if (err.code === 'REVISION_CONFLICT') ps().setSave({ state: 'conflict', error: 'This project was changed somewhere else.' });
    throw err;
  }
}

export async function deleteProject(projectId) {
  await api(`/projects/${projectId}`, { method: 'DELETE' });
  if (ps().projectId === projectId) ps().detach(); // the editor keeps the video and edits
}
