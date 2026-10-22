// Mounted once, next to <App/>. Restores a previous session silently, starts the
// autosave watcher, and hosts the account dialogs above whatever screen is showing.
// If the backend is unreachable everything here quietly stays in guest mode.

import { useEffect } from 'react';
import { useAuthStore } from './useAuthStore.js';
import { useProjectStore } from './useProjectStore.js';
import { initAutosave } from '../persistence/autosave.js';
import AuthDialog from './AuthDialog.jsx';
import { SaveDialog, ConflictDialog } from './SaveControls.jsx';
import { SavedProjectsDialog, VersionsDialog, RecoveryDialog } from './ProjectsDialogs.jsx';

export default function AccountLayer() {
  const dialog = useProjectStore((s) => s.dialog);

  useEffect(() => {
    initAutosave();
    void useAuthStore.getState().bootstrap();
  }, []);

  return (
    <>
      {dialog === 'save' && <SaveDialog />}
      {dialog === 'projects' && <SavedProjectsDialog />}
      {dialog === 'versions' && <VersionsDialog />}
      {dialog === 'recovery' && <RecoveryDialog />}
      {dialog === 'conflict' && <ConflictDialog />}
      <AuthDialog />
      <Toast />
    </>
  );
}

function Toast() {
  const toast = useProjectStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => useProjectStore.getState().clearToast(), toast.kind === 'warn' || toast.kind === 'error' ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  const tone =
    toast.kind === 'success'
      ? 'border-wave/40'
      : toast.kind === 'warn'
        ? 'border-amber-500/50'
        : toast.kind === 'error'
          ? 'border-red-500/50'
          : 'border-line';
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex justify-center px-4">
      <div role="status" className={`panel fade-up pointer-events-auto max-w-md border px-4 py-2.5 text-sm ${tone}`}>
        {toast.text}
      </div>
    </div>
  );
}
