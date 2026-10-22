// Header control: "Sign in" for guests; for signed-in users a menu with Saved
// projects, Versions, Link Google and Sign out. Signing out keeps the editor as is.

import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from './useAuthStore.js';
import { useProjectStore } from './useProjectStore.js';
import { googleEnabled } from './googleIdentity.js';
import { FolderIcon, HistoryIcon, LinkIcon, LogoutIcon, UserIcon } from './ui.jsx';

const item =
  'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fg transition-colors hover:bg-hover disabled:opacity-40';

export default function AccountMenu() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const projectId = useProjectStore((s) => s.projectId);
  const restorable = useProjectStore((s) => s.restorable);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (status === 'unknown') return <span className="inline-block h-9 w-9" aria-hidden="true" />;

  if (status === 'guest') {
    return (
      <button
        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line px-3 text-sm font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
        onClick={() => useAuthStore.getState().openAuth()}
        title="Sign in to save projects (optional)"
      >
        <UserIcon /> <span className="hidden sm:inline">Sign in</span>
      </button>
    );
  }

  const go = (fn) => () => {
    setOpen(false);
    fn();
  };
  const initial = (user?.displayName || user?.email || '?').trim()[0]?.toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-scarlet-400 to-scarlet-700 text-sm font-bold text-white shadow-[0_6px_20px_-8px_var(--glow)] transition-transform active:scale-95"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user?.email}
      >
        {initial}
      </button>
      {open && (
        <div role="menu" className="panel fade-up absolute right-0 top-11 z-50 w-64 p-1.5">
          <div className="px-3 pb-2 pt-1.5">
            <div className="truncate text-sm font-semibold">{user?.displayName}</div>
            <div className="truncate text-xs text-muted">{user?.email}</div>
          </div>
          <div className="my-1 h-px bg-line" />
          <button role="menuitem" className={item} onClick={go(() => useProjectStore.getState().openDialog('projects'))}>
            <FolderIcon className="text-muted" /> Saved projects
          </button>
          <button
            role="menuitem"
            className={item}
            disabled={!projectId || !restorable}
            onClick={go(() => useProjectStore.getState().openDialog('versions'))}
          >
            <HistoryIcon className="text-muted" /> Version history
          </button>
          {googleEnabled && !user?.googleLinked && (
            <button role="menuitem" className={item} onClick={go(() => useAuthStore.getState().openAuth({ mode: 'link-signed-in' }))}>
              <LinkIcon className="text-muted" /> Link Google account
            </button>
          )}
          <div className="my-1 h-px bg-line" />
          <button
            role="menuitem"
            className={item}
            onClick={go(async () => {
              useProjectStore.getState().detach(); // stop saving; the editor keeps everything
              await useAuthStore.getState().logout();
              useProjectStore.getState().showToast('Signed out. You can keep editing as a guest.');
            })}
          >
            <LogoutIcon className="text-muted" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
