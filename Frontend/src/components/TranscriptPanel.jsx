import { useMemo } from 'react';
import { useEditorStore } from '../store/useEditorStore.js';
import { isSpanRemoved } from '../lib/edl.js';
import * as I from './icons.jsx';
import FillerReview, { RemoveFillersButton } from './FillerReview.jsx';

/** Card around the transcript: header with live stats, scroll area, shortcut hints. */
export default function TranscriptPanel({ children }) {
  const status = useEditorStore((s) => s.status);
  const words = useEditorStore((s) => s.words);
  const removedRanges = useEditorStore((s) => s.removedRanges);
  const cut = useMemo(() => words.filter((w) => isSpanRemoved(w, removedRanges)).length, [words, removedRanges]);
  const ready = status === 'ready';

  return (
    <section className="panel fade-up flex min-h-[420px] flex-col overflow-hidden lg:min-h-0" style={{ animationDelay: '80ms' }}>
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-accent-soft text-[14px] text-accent">
          <I.Text />
        </div>
        <h2 className="text-sm font-semibold">Transcript</h2>
        {ready && (
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted">
            <span className="rounded-full border border-line px-2 py-0.5 tabular-nums">{words.length} words</span>
            {cut > 0 && <span className="rounded-full bg-accent-soft px-2 py-0.5 tabular-nums text-accent">{cut} cut</span>}
            <RemoveFillersButton />
          </div>
        )}
      </div>

      {ready && <FillerReview />}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {ready ? children : <Skeleton />}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-raised/60 px-5 py-2 text-[11px] text-subtle">
        <I.Keyboard className="text-[13px]" />
        <Hint k="Click / drag">select</Hint>
        <Hint k="Del">cut / restore</Hint>
        <Hint k="Space">play</Hint>
        <Hint k="← →">word edge</Hint>
        <Hint k="Ctrl Z">undo</Hint>
      </div>
    </section>
  );
}

function Hint({ k, children }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded border border-line bg-surface px-1 font-mono text-[10px] text-muted">{k}</kbd>
      {children}
    </span>
  );
}

function Skeleton() {
  const widths = [92, 78, 85, 64, 88, 72, 40];
  return (
    <div>
      <p className="mb-5 text-sm text-subtle">The transcript will appear here once transcription finishes.</p>
      <div className="space-y-3">
        {widths.map((w, i) => (
          <div
            key={i}
            className="h-3.5 animate-pulse rounded-full bg-hover"
            style={{ width: `${w}%`, animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
    </div>
  );
}