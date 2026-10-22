// Which saved project (if any) the open editing session belongs to, and the state of
// saving it. This is session context, not edit state: the editor store remains the
// only source of truth for words / removedRanges / undo history.

import { create } from 'zustand';

const initialLink = {
  projectId: null,
  ownerId: null, // the signed-in user who owns it; another account never writes to it
  title: '',
  revision: null,
  restorable: false, // true once the original video is fully uploaded
  currentVersion: 0,
  source: null, // { filename, sizeBytes, sha256, durationS, status }
  attachedFile: null, // the File object in the editor this project was saved from / opened with
  lastSavedKey: null, // editorStateKey() of the last state the server accepted
};

export const useProjectStore = create((set) => ({
  ...initialLink,
  save: { state: 'idle', error: null, lastSavedAt: null }, // idle|dirty|saving|saved|error|conflict
  job: null, // long-running action shown in a dialog: { kind, phase, progress, error }
  dialog: null, // null | 'save' | 'projects' | 'versions' | 'recovery' | 'conflict'
  recovery: null, // { projectId, detail, reason, mode: 'missing' | 'draft' }
  toast: null, // { text, kind }

  attach({ project, file, lastSavedKey, ownerId }) {
    set({
      projectId: project.id,
      ownerId,
      title: project.title,
      revision: project.revision,
      restorable: project.restorable,
      currentVersion: project.currentVersion,
      source: project.source,
      attachedFile: file,
      lastSavedKey,
      save: { state: 'saved', error: null, lastSavedAt: Date.now() },
    });
  },
  updateProject(project) {
    set({
      title: project.title,
      revision: project.revision,
      restorable: project.restorable,
      currentVersion: project.currentVersion,
      source: project.source,
    });
  },
  detach() {
    set({ ...initialLink, save: { state: 'idle', error: null, lastSavedAt: null } });
  },

  setSave(patch) {
    set((s) => ({ save: { ...s.save, ...patch } }));
  },
  setJob(job) {
    set({ job });
  },
  openDialog(dialog, extra = {}) {
    set({ dialog, ...extra });
  },
  closeDialog() {
    set({ dialog: null, recovery: null });
  },
  showToast(text, kind = 'info') {
    set({ toast: { text, kind, at: Date.now() } });
  },
  clearToast() {
    set({ toast: null });
  },
}));
