import { useEditorStore } from '../store/useEditorStore.js';

const BUSY = ['loading', 'extracting', 'model', 'transcribing'];

/** Progress for the ingest pipeline (FR-2: progress bar, UI stays responsive). */
export default function StatusBar() {
  const status = useEditorStore((s) => s.status);
  const statusText = useEditorStore((s) => s.statusText);
  const progress = useEditorStore((s) => s.progress);
  const error = useEditorStore((s) => s.error);

  if (status === 'error') {
    return <div className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>;
  }
  if (!BUSY.includes(status)) return null;

  const showBar = status === 'model' || status === 'transcribing';
  return (
    <div className="rounded-lg bg-zinc-900 px-4 py-3">
      <div className="flex justify-between text-sm">
        <span>{statusText || 'Working…'}</span>
        {showBar && <span className="tabular-nums text-zinc-400">{Math.round(progress * 100)}%</span>}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full bg-scarlet-500 transition-[width] ${showBar ? '' : 'w-1/3 animate-pulse'}`}
          style={showBar ? { width: `${progress * 100}%` } : undefined}
        />
      </div>
    </div>
  );
}
