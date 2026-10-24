// Subtitle settings: on/off, style, position, size, words per caption.
//
// Kept apart from the editor store on purpose: these are presentation settings, not
// edits. They don't go into undo/redo or removedRanges, and they survive opening another
// video. They're remembered per browser (localStorage), and are not yet saved with
// cloud projects.

import { create } from 'zustand';
import { DEFAULT_STYLE_ID, getCaptionStyle } from '../lib/captionStyles.js';

const KEY = 'scarlet.subtitles.v1';

export const SUBTITLE_DEFAULTS = {
  enabled: false,
  styleId: DEFAULT_STYLE_ID,
  x: 0.5, // centre of the caption, 0..1 across the frame
  y: 0.82, // centre of the caption, 0..1 down the frame
  scale: 1, // 0.5 .. 2.5
  maxWords: 4, // words per caption, 1 .. 8
};

export const POSITION_PRESETS = {
  top: { x: 0.5, y: 0.14 },
  middle: { x: 0.5, y: 0.5 },
  bottom: { x: 0.5, y: 0.82 },
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return SUBTITLE_DEFAULTS;
    return sanitize({ ...SUBTITLE_DEFAULTS, ...saved });
  } catch {
    return SUBTITLE_DEFAULTS; // private mode, blocked storage, bad JSON
  }
}

function persist(state) {
  try {
    const { enabled, styleId, x, y, scale, maxWords } = state;
    localStorage.setItem(KEY, JSON.stringify({ enabled, styleId, x, y, scale, maxWords }));
  } catch {
    // Storage unavailable: settings still work for this session.
  }
}

const num = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

export function sanitize(s) {
  return {
    enabled: Boolean(s.enabled),
    styleId: getCaptionStyle(s.styleId).id,
    x: num(s.x, 0, 1, SUBTITLE_DEFAULTS.x),
    y: num(s.y, 0, 1, SUBTITLE_DEFAULTS.y),
    scale: num(s.scale, 0.5, 2.5, 1),
    maxWords: Math.round(num(s.maxWords, 1, 8, 4)),
  };
}

export const useSubtitleStore = create((set, get) => ({
  ...load(),
  panelOpen: false, // the style panel over the preview (UI only, not remembered)

  update: (patch) => {
    const next = sanitize({ ...get(), ...patch });
    set(next);
    persist(next);
  },
  toggle: () => get().update({ enabled: !get().enabled }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  resetLayout: () => get().update({ x: SUBTITLE_DEFAULTS.x, y: SUBTITLE_DEFAULTS.y, scale: 1 }),
}));
