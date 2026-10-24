// Caption pages for the current edit, shared by the preview and the export button.
// Rebuilt whenever words, cuts or "words per caption" change, so captions always
// follow the edits.

import { useMemo } from 'react';
import { useEditorStore } from './useEditorStore.js';
import { useSubtitleStore } from './useSubtitleStore.js';
import { buildCaptionPages } from '../lib/captions.js';

export function useCaptionPages() {
  const words = useEditorStore((s) => s.words);
  const removedRanges = useEditorStore((s) => s.removedRanges);
  const maxWords = useSubtitleStore((s) => s.maxWords);
  return useMemo(() => buildCaptionPages(words, removedRanges, { maxWords }), [words, removedRanges, maxWords]);
}
