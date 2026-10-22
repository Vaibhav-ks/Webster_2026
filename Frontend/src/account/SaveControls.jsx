// The Save button in the editor toolbar, the first-save dialog (with an explicit
// "this uploads your original video" notice), and the conflict prompt.

import { useState } from 'react';
import { useEditorStore } from '../store/useEditorStore.js';
import { useAuthStore } from './useAuthStore.js';
import { useProjectStore } from './useProjectStore.js';
import { saveNewProject, resumeUpload, saveVersion, cancelJob, resolveConflict, MAX_UPLOAD_BYTES } from '../persistence/actions.js';
import { titleFromFilename } from '../persistence/projectState.js';
import { Modal, ErrorNote, Note, Progress, btn, primary, secondary, ghost, input, formatBytes, timeAgo, CloudIcon, CloudOkIcon, CloudOffIcon } from './ui.jsx';

const tbtn =
  'inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-muted transition-all duration-150 hover:bg-hover hover:text-fg active:scale-95 disabled:pointer-events-none disabled:opacity-35';

/** Toolbar button. Guests: opens sign-in. Signed in: first save / save version / retry. */
export function SaveProjectButton() {
  const status = useEditorStore((s) => s.status);
  const authStatus = useAuthStore((s) => s.status);
  const projectId = useProjectStore((s) => s.projectId);
  const restorable = useProjectStore((s) => s.restorable);
  const save = useProjectStore((s) => s.save);
  const job = useProjectStore((s) => s.job);

  const ready = status === 'ready';
  const uploading = job?.kind === 'save' && ['hash', 'create', 'upload'].includes(job.phase);

  const onClick = () => {
    const ps = useProjectStore.getState();
    if (authStatus !== 'authenticated') return useAuthStore.getState().openAuth({ reason: 'save' });
    if (!projectId || uploading || !restorable) return ps.openDialog('save');
    if (save.state === 'conflict') return ps.openDialog('conflict');
    void saveVersion();
  };

  let icon = <CloudIcon />;
  let label = 'Save';
  let title = 'Save this project to your account';
  if (projectId) {
    if (uploading) {
      label = job.phase === 'upload' ? `Uploading ${Math.round((job.progress ?? 0) * 100)}%` : 'Preparing…';
      title = 'Uploading the original video';
    } else if (!restorable) {
      icon = <CloudOffIcon className="text-amber-500" />;
      label = 'Finish upload';
      title = 'The original video has not finished uploading';
    } else if (save.state === 'saving') {
      label = 'Saving…';
    } else if (save.state === 'saved') {
      icon = <CloudOkIcon className="text-wave" />;
      label = 'Saved';
      title = `All changes saved${save.lastSavedAt ? ` (${timeAgo(save.lastSavedAt)})` : ''}. Click to save a version.`;
    } else if (save.state === 'dirty') {
      title = 'Unsaved changes. Autosaving shortly; click to save a version now.';
    } else if (save.state === 'error') {
      icon = <CloudOffIcon className="text-red-500" />;
      label = 'Retry save';
      title = save.error ?? 'Saving failed';
    } else if (save.state === 'conflict') {
      icon = <CloudOffIcon className="text-amber-500" />;
      label = 'Resolve';
      title = save.error ?? 'Saved somewhere else';
    }
  }

  return (
    <button className={tbtn} disabled={!ready || authStatus === 'unknown'} onClick={onClick} title={title}>
      {icon} <span className="hidden md:inline">{label}</span>
    </button>
  );
}

const PHASES = {
  hash: 'Fingerprinting the video (checksum)…',
  create: 'Saving transcript and edits…',
  upload: 'Uploading the original video…',
  finalize: 'Verifying the upload…',
};

export function SaveDialog() {
  const file = useEditorStore((s) => s.file);
  const projectId = useProjectStore((s) => s.projectId);
  const restorable = useProjectStore((s) => s.restorable);
  const job = useProjectStore((s) => s.job);
  const close = () => {
    const ps = useProjectStore.getState();
    if (job && ['done', 'cancelled', 'error'].includes(job.phase)) ps.setJob(null);
    ps.closeDialog();
  };
  const [title, setTitle] = useState(() => titleFromFilename(file?.name));
  const running = job?.kind === 'save' && PHASES[job.phase];
  const tooBig = file && file.size > MAX_UPLOAD_BYTES;

  if (job?.kind === 'save' && job.phase === 'done') {
    return (
      <Modal title="Project saved" onClose={close}>
        <Note>Your original video, transcript and edits are saved privately to your account. Changes now save automatically.</Note>
        <button className={`${btn} ${primary} mt-4 w-full`} onClick={close}>
          Keep editing
        </button>
      </Modal>
    );
  }

  if (running) {
    return (
      <Modal title="Saving project">
        <Progress value={job.phase === 'create' ? null : job.progress} label={PHASES[job.phase]} />
        <p className="mt-3 text-xs text-subtle">You can keep editing while this runs. Edits made now are saved too.</p>
        <div className="mt-4 flex gap-2">
          <button className={`${btn} ${secondary}`} onClick={() => useProjectStore.getState().closeDialog()}>
            Hide
          </button>
          <button className={`${btn} ${ghost}`} onClick={cancelJob}>
            Cancel upload
          </button>
        </div>
      </Modal>
    );
  }

  // Attached project whose upload is unfinished: offer to resume.
  if (projectId && !restorable) {
    return (
      <Modal title="Finish saving" onClose={close}>
        <Note>
          The project is in your account, but its original video hasn&apos;t finished uploading, so it can&apos;t be reopened
          yet. Resuming continues from where the upload stopped.
        </Note>
        <ErrorNote>{job?.phase === 'error' ? job.error : null}</ErrorNote>
        {job?.phase === 'cancelled' && <p className="mt-3 text-sm text-muted">Upload cancelled.</p>}
        <div className="mt-4 flex gap-2">
          <button className={`${btn} ${primary} flex-1`} onClick={() => void resumeUpload()}>
            Resume upload
          </button>
          <button className={`${btn} ${ghost}`} onClick={close}>
            Later
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Save project" onClose={close}>
      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void saveNewProject({ title: title.trim() });
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Project name</span>
          <input className={input} value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="rounded-xl border border-accent/30 bg-accent-soft px-3 py-2.5 text-sm">
          <div className="font-medium text-fg">This uploads your original video</div>
          <div className="mt-0.5 text-muted">
            {file?.name} · {formatBytes(file?.size)} goes to private storage in your account so you can reopen this project on
            any device. Editing and export still happen on this device.
          </div>
        </div>
        {tooBig && <ErrorNote>Videos up to {formatBytes(MAX_UPLOAD_BYTES)} can be saved to your account.</ErrorNote>}
        <ErrorNote>{job?.kind === 'save' && job.phase === 'error' ? job.error : null}</ErrorNote>
        {job?.phase === 'cancelled' && <p className="text-sm text-muted">Upload cancelled. Nothing in the editor changed.</p>}
        <div className="flex gap-2 pt-1">
          <button type="submit" className={`${btn} ${primary} flex-1`} disabled={tooBig || !title.trim()}>
            <CloudIcon /> Upload &amp; save
          </button>
          <button type="button" className={`${btn} ${ghost}`} onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ConflictDialog() {
  const save = useProjectStore((s) => s.save);
  const [busy, setBusy] = useState(false);
  const run = async (choice) => {
    setBusy(true);
    await resolveConflict(choice);
    setBusy(false);
  };
  return (
    <Modal title="Saved somewhere else" onClose={() => useProjectStore.getState().closeDialog()}>
      <Note>
        {save.error ?? 'This project was changed in another tab or on another device.'} Nothing has been overwritten. Choose
        which edits to keep.
      </Note>
      <div className="mt-4 grid gap-2">
        <button className={`${btn} ${primary}`} disabled={busy} onClick={() => run('overwrite')}>
          Keep the edits on this screen
        </button>
        <button className={`${btn} ${secondary}`} disabled={busy} onClick={() => run('reload')}>
          Load the other saved edits (undo brings mine back)
        </button>
      </div>
    </Modal>
  );
}
