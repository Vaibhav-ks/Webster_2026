// Saved projects list, version history, and the recovery flow for missing media.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectStore } from './useProjectStore.js';
import { api } from './api.js';
import { openProject, openWouldDiscardWork, deleteProject, relinkAndOpen, restoreVersion, cancelJob } from '../persistence/actions.js';
import { formatTime } from '../lib/transcript.js';
import { Modal, ErrorNote, Note, Progress, btn, primary, secondary, ghost, danger, formatBytes, timeAgo } from './ui.jsx';

const OPEN_PHASES = {
  load: 'Loading project…',
  download: 'Downloading the original video…',
  verify: 'Verifying the video checksum…',
  restore: 'Restoring transcript and edits…',
};

export function SavedProjectsDialog() {
  const close = () => {
    const ps = useProjectStore.getState();
    if (ps.job?.kind === 'open' && ps.job.phase === 'error') ps.setJob(null);
    ps.closeDialog();
  };
  const currentId = useProjectStore((s) => s.projectId);
  const job = useProjectStore((s) => s.job);
  const [state, setState] = useState({ loading: true, projects: [], error: null });
  const [confirm, setConfirm] = useState(null); // { kind: 'delete' | 'replace', project }
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const { projects } = await api('/projects');
      setState({ loading: false, projects, error: null });
    } catch (err) {
      setState({ loading: false, projects: [], error: err.message });
    }
  }, []);
  useEffect(() => void load(), [load]);

  const opening = job?.kind === 'open' && OPEN_PHASES[job.phase];
  if (opening) {
    return (
      <Modal title="Opening project">
        <Progress value={job.phase === 'download' || job.phase === 'verify' ? job.progress ?? 0 : null} label={OPEN_PHASES[job.phase]} />
        <button className={`${btn} ${ghost} mt-4`} onClick={cancelJob} disabled={job.phase === 'restore'}>
          Cancel
        </button>
      </Modal>
    );
  }

  const open = (project) => {
    if (openWouldDiscardWork() && confirm?.project?.id !== project.id) {
      return setConfirm({ kind: 'replace', project });
    }
    setConfirm(null);
    void openProject(project.id);
  };

  const remove = async (project) => {
    setBusyId(project.id);
    try {
      await deleteProject(project.id);
      setConfirm(null);
      await load();
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal title="Saved projects" onClose={close} wide>
      <ErrorNote>{job?.kind === 'open' && job.phase === 'error' ? job.error : state.error}</ErrorNote>
      {state.loading && <Progress value={null} label="Loading your projects…" />}
      {!state.loading && !state.error && state.projects.length === 0 && (
        <Note>No saved projects yet. Open a video, then use Save in the toolbar.</Note>
      )}
      <ul className="mt-4 space-y-2">
        {state.projects.map((p) => (
          <li key={p.id} className="rounded-xl border border-line bg-raised p-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{p.title}</span>
                  {p.id === currentId && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">Open</span>}
                  {!p.restorable && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-300">
                      Upload unfinished
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted">
                  {p.source?.filename} · {formatBytes(p.source?.sizeBytes)} · {formatTime(p.source?.durationS ?? 0)} · edited{' '}
                  {timeAgo(p.updatedAt)}
                </div>
              </div>
              <div className="flex gap-1.5">
                <button className={`${btn} ${secondary} h-8`} onClick={() => open(p)} disabled={p.id === currentId}>
                  Open
                </button>
                <button
                  className={`${btn} ${ghost} h-8`}
                  onClick={() => setConfirm({ kind: 'delete', project: p })}
                  disabled={busyId === p.id}
                >
                  Delete
                </button>
              </div>
            </div>
            {confirm?.project.id === p.id && confirm.kind === 'replace' && (
              <div className="mt-3 rounded-lg border border-line bg-surface p-3 text-sm">
                <p className="text-muted">
                  The video open in the editor has changes that aren&apos;t saved to your account. Opening this project will
                  replace it.
                </p>
                <div className="mt-2 flex gap-2">
                  <button className={`${btn} ${primary} h-8`} onClick={() => open(p)}>
                    Open anyway
                  </button>
                  <button className={`${btn} ${ghost} h-8`} onClick={() => setConfirm(null)}>
                    Keep current
                  </button>
                </div>
              </div>
            )}
            {confirm?.project.id === p.id && confirm.kind === 'delete' && (
              <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm">
                <p className="text-muted">
                  Delete “{p.title}” and its stored original video from your account? This can&apos;t be undone.
                  {p.id === currentId && ' The video stays open in the editor.'}
                </p>
                <div className="mt-2 flex gap-2">
                  <button className={`${btn} ${danger} h-8`} onClick={() => remove(p)} disabled={busyId === p.id}>
                    {busyId === p.id ? 'Deleting…' : 'Delete project'}
                  </button>
                  <button className={`${btn} ${ghost} h-8`} onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function VersionsDialog() {
  const projectId = useProjectStore((s) => s.projectId);
  const title = useProjectStore((s) => s.title);
  const currentVersion = useProjectStore((s) => s.currentVersion);
  const close = () => useProjectStore.getState().closeDialog();
  const [state, setState] = useState({ loading: true, versions: [], error: null });
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const { versions } = await api(`/projects/${projectId}/versions`);
      setState({ loading: false, versions, error: null });
    } catch (err) {
      setState({ loading: false, versions: [], error: err.message });
    }
  }, [projectId]);
  useEffect(() => void load(), [load, currentVersion]);

  const restore = async (v) => {
    setBusy(v.id);
    try {
      await restoreVersion(v);
      await load();
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title={`Versions of “${title}”`} onClose={close} wide>
      <Note>
        Versions are snapshots of your cuts, made each time you click Save. Restoring one keeps everything: it saves your
        current edits first and adds the restored cuts as a new version.
      </Note>
      <ErrorNote>{state.error}</ErrorNote>
      {state.loading && <Progress value={null} label="Loading versions…" />}
      <ul className="mt-4 space-y-1.5">
        {state.versions.map((v) => (
          <li key={v.id} className="flex items-center gap-3 rounded-xl border border-line bg-raised px-3 py-2">
            <span className="w-10 font-mono text-xs text-subtle">v{v.versionNumber}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{v.changeSummary || 'Saved'}</div>
              <div className="text-xs text-muted">{new Date(v.createdAt).toLocaleString()}</div>
            </div>
            {v.versionNumber === currentVersion ? (
              <span className="text-xs text-subtle">Latest</span>
            ) : (
              <button className={`${btn} ${secondary} h-8`} onClick={() => restore(v)} disabled={Boolean(busy)}>
                {busy === v.id ? 'Restoring…' : 'Restore'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Original video missing / damaged / never finished uploading: relink a local copy. */
export function RecoveryDialog() {
  const rec = useProjectStore((s) => s.recovery);
  const job = useProjectStore((s) => s.job);
  const inputRef = useRef(null);
  if (!rec) return null;
  const src = rec.detail.project.source;
  const close = () => {
    useProjectStore.getState().setJob(null);
    useProjectStore.getState().closeDialog();
  };
  const verifying = job?.kind === 'relink' && job.phase === 'verify';
  const restoring = job?.kind === 'open' && job.phase === 'restore';
  const retryable = rec.code === 'DOWNLOAD_FAILED' || rec.code === 'SOURCE_CORRUPT';

  return (
    <Modal title={`Open “${rec.detail.project.title}”`} onClose={verifying || restoring ? undefined : close}>
      <Note>
        {rec.reason} Your transcript and cuts are safe. To continue, choose the original video from this device:{' '}
        <strong className="text-fg">{src?.filename}</strong> ({formatBytes(src?.sizeBytes)}). It is checked against the saved
        fingerprint, so only the exact same file is accepted.
        {rec.mode === 'missing' ? ' It will then be uploaded again so the project works on every device.' : ''}
        {rec.mode === 'draft' ? ' The unfinished upload then resumes.' : ''}
      </Note>
      {verifying && <Progress value={job.progress} label="Checking that this is the original video…" />}
      {restoring && <Progress value={null} label="Restoring transcript and edits…" />}
      <ErrorNote>{job?.kind === 'relink' && job.phase === 'error' ? job.error : null}</ErrorNote>
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void relinkAndOpen(f);
        }}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <button className={`${btn} ${primary} flex-1`} onClick={() => inputRef.current?.click()} disabled={verifying || restoring}>
          Choose original video…
        </button>
        {retryable && (
          <button
            className={`${btn} ${secondary}`}
            disabled={verifying || restoring}
            onClick={() => {
              useProjectStore.getState().openDialog('projects', { recovery: null });
              void openProject(rec.projectId);
            }}
          >
            Try download again
          </button>
        )}
        <button className={`${btn} ${ghost}`} onClick={close} disabled={verifying || restoring}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
