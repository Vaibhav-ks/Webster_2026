import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useSubtitleStore, sanitize, SUBTITLE_DEFAULTS } from './useSubtitleStore.js';

test('settings are clamped and unknown styles fall back to the default', () => {
  const s = sanitize({ enabled: 1, styleId: 'nope', x: 2, y: -1, scale: 99, maxWords: 3.6 });
  assert.deepEqual(s, { enabled: true, styleId: SUBTITLE_DEFAULTS.styleId, x: 1, y: 0, scale: 2.5, maxWords: 4 });
});

test('one click turns subtitles on; works without localStorage (Node has none)', () => {
  const st = useSubtitleStore.getState();
  assert.equal(st.enabled, false);
  st.toggle();
  assert.equal(useSubtitleStore.getState().enabled, true);
  useSubtitleStore.getState().update({ x: 0.3, scale: 1.4 });
  useSubtitleStore.getState().resetLayout();
  const after = useSubtitleStore.getState();
  assert.equal(after.x, SUBTITLE_DEFAULTS.x);
  assert.equal(after.scale, 1);
  assert.equal(after.enabled, true);
});
