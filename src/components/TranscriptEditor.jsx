import { memo, useEffect, useMemo, useRef } from 'react';
import { useEditorStore, getSelectionSpan } from '../store/useEditorStore.js';
import { isSpanRemoved } from '../lib/edl.js';
import { gapLabel } from '../lib/transcript.js';
import { player } from '../media/player.js';
import { deleteOrRestoreSelection } from './editActions.js';

/**
 * Read-only transcript (FR-3, FR-11). Each word and gap is its own element; there is no
 * contenteditable, so typing and pasting are impossible by construction.
 *
 * Selection is by whole items: click selects one, drag or shift-click extends.
 * Delete/Backspace cuts the selection; on an already-deleted selection it restores.
 */
export default function TranscriptEditor() {
  const items = useEditorStore((s) => s.items);
  const removedRanges = useEditorStore((s) => s.removedRanges);
  const selection = useEditorStore((s) => s.selection);
  const setSelection = useEditorStore((s) => s.setSelection);
  const dragging = useRef(false);

  const removed = useMemo(() => items.map((it) => isSpanRemoved(it, removedRanges)), [items, removedRanges]);

  const span = getSelectionSpan({ selection, items });

  useEffect(() => {
    const stop = () => (dragging.current = false);
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, []);

  const onPointerDown = (index, e) => {
    e.preventDefault();
    if (e.shiftKey && selection) {
      setSelection({ anchor: selection.anchor, focus: index });
    } else {
      setSelection({ anchor: index, focus: index });
      player.seek(items[index].start);
    }
    dragging.current = true;
  };

  const onPointerEnter = (index) => {
    if (!dragging.current) return;
    const { selection: sel } = useEditorStore.getState();
    if (sel) setSelection({ anchor: sel.anchor, focus: index });
  };

  if (!items.length) {
    return <p className="text-zinc-500">No speech was found in this video.</p>;
  }

  return (
    <div className="select-none text-lg leading-relaxed">
      {items.map((item, i) => (
        <Item
          key={item.id}
          item={item}
          index={i}
          removed={removed[i]}
          selected={span ? i >= span.lo && i <= span.hi : false}
          onPointerDown={onPointerDown}
          onPointerEnter={onPointerEnter}
        />
      ))}
    </div>
  );
}

const Item = memo(function Item({ item, index, removed, selected, onPointerDown, onPointerEnter }) {
  const active = useEditorStore((s) => s.activeWordId === item.id);
  const ref = useRef(null);

  useEffect(() => {
    // Follow the playhead only while playing, so it doesn't fight the user's scrolling.
    const playing = player.element && !player.element.paused;
    if (active && playing) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);

  const base = 'cursor-pointer rounded px-0.5 transition-colors';
  const state = [
    removed ? 'line-through decoration-scarlet-500 decoration-2 text-zinc-600' : '',
    selected ? 'bg-scarlet-500/30' : 'hover:bg-zinc-800',
    active && !removed ? 'bg-amber-300 text-zinc-950' : '',
  ].join(' ');

  const props = {
    ref,
    'data-index': index,
    onPointerDown: (e) => onPointerDown(index, e),
    onPointerEnter: () => onPointerEnter(index),
  };

  if (item.kind === 'gap') {
    return (
      <span {...props} className={`${base} ${state} mx-0.5 inline-block text-sm text-zinc-500 italic`}>
        [ {gapLabel(item)} ]
      </span>
    );
  }
  return (
    <span {...props} className={`${base} ${state}`}>
      {item.text}{' '}
    </span>
  );
});

/** Keyboard shortcuts for the transcript. Mounted once by the editor screen. */
export function useTranscriptShortcuts() {
  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, video')) return;
      const s = useEditorStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteOrRestoreSelection();
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
      } else if (e.key === 'Escape') {
        s.setSelection(null);
      } else if (e.key === ' ') {
        e.preventDefault();
        player.togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
