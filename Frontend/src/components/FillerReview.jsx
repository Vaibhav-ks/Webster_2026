import { useMemo, useState } from 'react';
import { useEditorStore } from '../store/useEditorStore.js';
import { FILLER, UNCERTAIN, KEEP, buildFillerCuts } from '../lib/fillers.js';
import { normalize } from '../lib/ranges.js';
import { editedDuration } from '../lib/edl.js';
import { formatClock } from '../lib/timeline.js';
import { player } from '../media/player.js';
import {
  analyzeFillers,
  toggleFillerCandidate,
  setFillerSelection,
  applyFillerRemoval,
  undoFillerRemoval,
  canUndoFillerRemoval,
  closeFillerReview,
} from '../store/fillerActions.js';
import * as I from './icons.jsx';

const btn =
  'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold transition-all duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40';
const primary = 'bg-gradient-to-b from-scarlet-400 to-scarlet-600 text-white shadow-[0_8px_24px_-8px_var(--glow)] hover:brightness-110';
const secondary = 'border border-line bg-raised text-fg hover:bg-hover';
const link = 'text-[11px] font-medium text-muted hover:text-fg';

const KIND = {
  hesitation: 'hesitation',
  discourse: 'context word',
  repetition: 'repeat',
  fragment: 'cut-off word',
  sound: 'unlabelled sound',
};

/** "Remove fillers" button for the transcript header. */
export function RemoveFillersButton() {
  const status = useEditorStore((s) => s.status);
  const phase = useEditorStore((s) => s.fillerReview?.phase);
  return (
    <button
      type="button"
      className={`${btn} ${secondary} h-7 px-2.5 text-[12px]`}
      disabled={status !== 'ready' || phase === 'analyzing'}
      onClick={() => analyzeFillers()}
      title="Find filler words, repeats and hesitations, then review them before cutting"
    >
      <I.Sparkle className="text-accent" /> Remove fillers
    </button>
  );
}

/** Review card shown above the transcript while a filler review is open. */
export default function FillerReview() {
  const review = useEditorStore((s) => s.fillerReview);
  const canUndo = useEditorStore((s) => canUndoFillerRemoval(s));
  if (!review) return null;

  return (
    <div className="flex max-h-[55%] min-h-0 flex-col border-b border-line bg-raised/50">
      <div className="flex items-center gap-2 border-b border-line/60 px-5 pb-2 pt-3">
        <I.Sparkle className="text-accent" />
        <h3 className="text-[13px] font-semibold">Filler words</h3>
        {review.phase === 'review' && (
          <span className="text-[11px] text-subtle">
            {review.audioUsed ? 'transcript + audio' : 'transcript only (audio not analysed)'}
          </span>
        )}
        <button type="button" className="ml-auto rounded-md p-1 text-muted hover:bg-hover hover:text-fg" onClick={closeFillerReview} aria-label="Close filler review">
          <I.X />
        </button>
      </div>

      {review.phase === 'analyzing' && (
        <div className="px-5 pb-4 pt-2">
          <p className="text-[13px] text-muted">Analysing transcript and audio…</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken">
            <div className="shimmer h-full w-full rounded-full" />
          </div>
        </div>
      )}

      {review.phase === 'error' && (
        <div className="px-5 pb-4 pt-2">
          <p className="text-[13px] text-red-500 dark:text-red-300">{review.error}</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className={`${btn} ${secondary}`} onClick={() => analyzeFillers()}>
              Try again
            </button>
            <button type="button" className={`${btn} ${secondary}`} onClick={closeFillerReview}>
              Close
            </button>
          </div>
        </div>
      )}

      {review.phase === 'review' && <ReviewList review={review} />}

      {review.phase === 'applied' && (
        <div className="px-5 pb-4 pt-2">
          <p className="text-[13px]">
            Removed {review.applied.count} {review.applied.count === 1 ? 'filler' : 'fillers'}
            <span className="ml-1.5 rounded-full bg-accent-soft px-1.5 font-mono text-[11px] text-accent">
              −{review.applied.saved.toFixed(1)}s
            </span>
          </p>
          <p className="mt-1 text-[11px] text-subtle">
            {canUndo
              ? 'The cuts are in the preview, timeline and export. Undo brings them all back in one step.'
              : 'You have edited since. Use Undo in the toolbar to step back through your edits.'}
          </p>
          <div className="mt-3 flex gap-2">
            <button type="button" className={`${btn} ${secondary}`} disabled={!canUndo} onClick={undoFillerRemoval}>
              <I.Undo /> Undo
            </button>
            <button type="button" className={`${btn} ${secondary}`} onClick={closeFillerReview}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewList({ review }) {
  const duration = useEditorStore((s) => s.duration);
  const removedRanges = useEditorStore((s) => s.removedRanges);
  const [showKept, setShowKept] = useState(false);
  const { candidates, selected } = review;

  const groups = useMemo(
    () => ({
      [FILLER]: candidates.filter((c) => c.label === FILLER),
      [UNCERTAIN]: candidates.filter((c) => c.label === UNCERTAIN),
      [KEEP]: candidates.filter((c) => c.label === KEEP),
    }),
    [candidates],
  );

  const { count, saved } = useMemo(() => {
    const cuts = buildFillerCuts(candidates, selected, duration);
    const after = editedDuration(normalize([...removedRanges, ...cuts]), duration);
    return {
      count: candidates.filter((c) => selected[c.id] && c.cuttable).length,
      saved: editedDuration(removedRanges, duration) - after,
    };
  }, [candidates, selected, removedRanges, duration]);

  const nothing = !groups[FILLER].length && !groups[UNCERTAIN].length;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2 pt-2">
        {nothing && (
          <div className="rounded-lg border border-dashed border-line-strong px-3 py-3 text-[13px] text-muted">
            <p className="font-medium text-fg">No filler words found.</p>
            <p className="mt-1 text-[12px]">
              Whisper often leaves "um" and "uh" out of its transcript, so some may not show up here.
              {review.audioUsed ? '' : ' Audio could not be analysed, so unlabelled sounds were not checked.'}
            </p>
          </div>
        )}
        <Group title="Confident" hint="pre-selected" items={groups[FILLER]} selected={selected} labels={[FILLER]} />
        <Group title="Needs review" hint="not selected" items={groups[UNCERTAIN]} selected={selected} labels={[UNCERTAIN]} />
        {groups[KEEP].length > 0 && (
          <div className="mt-2">
            <button type="button" className={link} onClick={() => setShowKept(!showKept)}>
              {showKept ? '▾' : '▸'} Kept as meaningful ({groups[KEEP].length})
            </button>
            {showKept && <Group items={groups[KEEP]} selected={selected} labels={[KEEP]} />}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-2.5">
        <button type="button" className={`${btn} ${primary}`} disabled={!count} onClick={applyFillerRemoval}>
          <I.Scissors /> Remove {count} {count > 0 && <span className="font-mono text-[11px] opacity-90">−{saved.toFixed(1)}s</span>}
        </button>
        <button type="button" className={`${btn} ${secondary}`} onClick={closeFillerReview}>
          Cancel
        </button>
        {review.error && <span className="text-[12px] text-red-500 dark:text-red-300">{review.error}</span>}
      </div>
    </>
  );
}

function Group({ title, hint, items, selected, labels }) {
  if (!items.length) return null;
  return (
    <div className="mt-2 first:mt-0">
      {title && (
        <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-subtle">
          <span className="font-semibold text-muted">
            {title} ({items.length})
          </span>
          <span className="normal-case tracking-normal">{hint}</span>
          <span className="ml-auto flex gap-2 normal-case tracking-normal">
            <button type="button" className={link} onClick={() => setFillerSelection(labels, true)}>
              all
            </button>
            <button type="button" className={link} onClick={() => setFillerSelection(labels, false)}>
              none
            </button>
          </span>
        </div>
      )}
      <ul className="space-y-0.5">
        {items.map((c) => (
          <Row key={c.id} c={c} checked={Boolean(selected[c.id])} />
        ))}
      </ul>
    </div>
  );
}

function Row({ c, checked }) {
  const reveal = () => {
    if (!Number.isFinite(c.start)) return;
    player.seek(c.start);
    const id = c.wordIds[0];
    if (id) document.querySelector(`[data-item-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const disabled = !c.cuttable || c.alreadyCut;

  return (
    <li className={`group flex items-start gap-2 rounded-lg px-1.5 py-1 hover:bg-hover ${disabled ? 'opacity-60' : ''}`}>
      <input
        type="checkbox"
        className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-[var(--c-accent)]"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={() => toggleFillerCandidate(c.id)}
        aria-label={`Remove "${c.text}" at ${formatClock(c.start)}`}
      />
      <button type="button" onClick={reveal} className="min-w-0 flex-1 text-left">
        <span className="flex items-baseline gap-2">
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-subtle">
            {Number.isFinite(c.start) ? formatClock(c.start) : '–:––'}
          </span>
          <span className="min-w-0 truncate text-[13px]">
            <span className="text-subtle">{c.before && `…${c.before} `}</span>
            <span className={`font-semibold ${c.label === KEEP ? 'text-fg' : 'text-accent'}`}>{c.text}</span>
            <span className="text-subtle">{c.after && ` ${c.after}…`}</span>
          </span>
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-subtle">
          <span className="text-muted">{KIND[c.kind]}</span>
          {c.alreadyCut ? ' · already cut' : ''} · {c.reasons.join(' · ')}
        </span>
      </button>
      <button
        type="button"
        className="mt-0.5 shrink-0 rounded-md p-1 text-[12px] text-muted opacity-70 hover:bg-surface hover:text-fg group-hover:opacity-100"
        disabled={!Number.isFinite(c.start)}
        onClick={() => player.playSpan(c.start, c.end)}
        title="Listen (with a second of context)"
        aria-label="Listen"
      >
        <I.Play />
      </button>
    </li>
  );
}