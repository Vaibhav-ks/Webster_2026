import { useEditorStore } from '../store/useEditorStore.js';

const BUSY = ['loading', 'extracting', 'model', 'transcribing'];
const STEPS = [
  { key: 'extracting', label: 'Audio' },
  { key: 'model', label: 'Model' },
  { key: 'transcribing', label: 'Transcript' },
];

/** Progress for the ingest pipeline (FR-2: progress bar, UI stays responsive). */
export default function StatusBar() {
  const status = useEditorStore((s) => s.status);
  const statusText = useEditorStore((s) => s.statusText);
  const progress = useEditorStore((s) => s.progress);
  const error = useEditorStore((s) => s.error);

  if (status === 'error') {
    return (
      <div className="fade-up rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500 dark:text-red-300">
        {error}
      </div>
    );
  }
  if (!BUSY.includes(status)) return null;

  const showBar = status === 'model' || status === 'transcribing';
  const current = STEPS.findIndex((s) => s.key === status);
  return (
    <div className="panel fade-up px-4 py-3">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="flex items-center gap-2 font-medium">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          {statusText || 'Working…'}
        </span>
        <div className="hidden items-center gap-1.5 text-[11px] sm:flex">
          {STEPS.map((s, i) => (
            <span
              key={s.key}
              className={`rounded-full px-2 py-0.5 ${
                i < current ? 'bg-wave-bg text-wave' : i === current ? 'bg-accent-soft text-accent' : 'text-subtle'
              }`}
            >
              {i < current ? '✓ ' : ''}
              {s.label}
            </span>
          ))}
          {showBar && <span className="ml-1 w-9 text-right font-mono tabular-nums text-muted">{Math.round(progress * 100)}%</span>}
        </div>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-sunken">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${showBar ? 'bg-accent' : 'shimmer w-full'}`}
          style={showBar ? { width: `${progress * 100}%` } : undefined}
        />
      </div>
    </div>
  );
}