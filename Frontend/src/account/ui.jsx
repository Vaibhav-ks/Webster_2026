// Small building blocks for the account / saved-project UI, using the editor's own
// design tokens (panel, bg-surface, text-muted, accent…) so it looks native.

import { useEffect, useRef } from 'react';

export const btn =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold transition-all duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40';
export const primary =
  'bg-gradient-to-b from-scarlet-400 to-scarlet-600 text-white shadow-[0_8px_24px_-8px_var(--glow)] hover:brightness-110';
export const secondary = 'border border-line bg-raised text-fg hover:bg-hover';
export const ghost = 'text-muted hover:bg-hover hover:text-fg';
export const danger = 'border border-red-500/40 text-red-500 hover:bg-red-500/10 dark:text-red-300';
export const input =
  'h-10 w-full rounded-xl border border-line bg-sunken px-3 text-sm text-fg outline-none transition-colors placeholder:text-subtle focus:border-accent';

export function Modal({ title, onClose, children, wide = false, labelledBy = 'modal-title' }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && onClose) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    ref.current?.querySelector('input, button')?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}
      // Keep editor shortcuts (Delete, Space, Ctrl+Z…) from firing while typing here.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`panel fade-up max-h-[90vh] w-full overflow-y-auto p-6 ${wide ? 'max-w-2xl' : 'max-w-md'}`}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={labelledBy} className="text-lg font-semibold">
            {title}
          </h2>
          {onClose && (
            <button className={`${btn} ${ghost} -mr-2 -mt-1 h-8 w-8 px-0`} onClick={onClose} aria-label="Close">
              <XIcon />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500 dark:text-red-300" role="alert">
      {children}
    </p>
  );
}

export function Note({ children }) {
  return <p className="mt-3 rounded-xl border border-line bg-raised px-3 py-2 text-sm text-muted">{children}</p>;
}

export function Progress({ value, label }) {
  const indeterminate = value == null;
  return (
    <div className="mt-4">
      <div className="h-2 overflow-hidden rounded-full bg-sunken">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${indeterminate ? 'shimmer w-full' : 'bg-accent'}`}
          style={indeterminate ? undefined : { width: `${Math.round(value * 100)}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted">
        <span>{label}</span>
        {!indeterminate && <span className="font-mono tabular-nums">{Math.round(value * 100)}%</span>}
      </div>
    </div>
  );
}

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function timeAgo(date) {
  const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// --- icons (same 24×24 stroke style as components/icons.jsx) ---
function Icon({ children, className = '', ...rest }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {children}
    </svg>
  );
}
export const CloudIcon = (p) => (
  <Icon {...p}>
    <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5H7Z" />
    <path d="m9.5 13.5 2.5-2.5 2.5 2.5M12 11v5" />
  </Icon>
);
export const CloudOkIcon = (p) => (
  <Icon {...p}>
    <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5H7Z" />
    <path d="m9.5 13.5 2 2 3.5-4" />
  </Icon>
);
export const CloudOffIcon = (p) => (
  <Icon {...p}>
    <path d="M7 18a4.5 4.5 0 0 1-.6-8.96M9.5 6.3A6 6 0 0 1 18 9.5a4 4 0 0 1 1.7 7.6M3 3l18 18" />
  </Icon>
);
export const FolderIcon = (p) => (
  <Icon {...p}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" />
  </Icon>
);
export const HistoryIcon = (p) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </Icon>
);
export const UserIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Icon>
);
export const LinkIcon = (p) => (
  <Icon {...p}>
    <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />
  </Icon>
);
export const LogoutIcon = (p) => (
  <Icon {...p}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" />
  </Icon>
);
export const XIcon = (p) => (
  <Icon {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
);
