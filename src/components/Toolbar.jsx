import { useEditorStore } from '../store/useEditorStore.js';
import { editedDuration } from '../lib/edl.js';
import { formatTime } from '../lib/transcript.js';
import { deleteOrRestoreSelection, selectionIsRemoved } from './editActions.js';
import ExportButton from './ExportButton.jsx';

const btn =
  'rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40';

export default function Toolbar() {
  const s = useEditorStore();
  const ready = s.status === 'ready';
  const hasSelection = Boolean(s.selection);
  const restoring = hasSelection && selectionIsRemoved(s);
  const edited = editedDuration(s.removedRanges, s.duration);

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">
      <span className="mr-4 font-bold">
        <span className="text-scarlet-500">Scarlet</span> Rewrite
      </span>

      <button className={btn} disabled={!ready || !s.past.length} onClick={s.undo} title="Ctrl+Z">
        Undo
      </button>
      <button className={btn} disabled={!ready || !s.future.length} onClick={s.redo} title="Ctrl+Shift+Z">
        Redo
      </button>
      <button className={btn} disabled={!ready || !hasSelection} onClick={deleteOrRestoreSelection} title="Delete">
        {restoring ? 'Restore' : 'Delete'}
      </button>

      <div className="ml-auto flex items-center gap-4 text-sm text-zinc-400">
        {s.device && <span>Whisper on {s.device === 'webgpu' ? 'WebGPU' : 'WASM'}</span>}
        {s.duration > 0 && (
          <span className="tabular-nums">
            {formatTime(edited)} / {formatTime(s.duration)}
          </span>
        )}
        <ExportButton />
        <button className={btn} onClick={s.reset}>
          New video
        </button>
      </div>
    </header>
  );
}
