// A tiny handle to the preview <video>, so any component can seek or play
// without passing refs around. Phase 2 replaces <video> with a canvas renderer
// behind the same functions.
//
// Every user-facing seek (timeline, scrub bar, word stepping) goes through
// seekSnapped(), which applies the same word-boundary snapping as cuts, so the
// playhead, the video frame and the highlighted word always agree.

import { useEditorStore } from '../store/useEditorStore.js';
import { snapSeek } from '../lib/timeline.js';

let video = null;

export const player = {
  attach(el) {
    video = el;
  },
  detach(el) {
    if (video === el) video = null;
  },
  get element() {
    return video;
  },
  get time() {
    return video ? video.currentTime : 0;
  },
  seek(t) {
    if (video) video.currentTime = t;
  },
  /** Seek to t snapped to a word boundary (free inside silences). Returns the time used. */
  seekSnapped(t) {
    const { words, gaps, duration } = useEditorStore.getState();
    const s = snapSeek(t, words, gaps, duration || video?.duration || 0);
    this.seek(s);
    return s;
  },
  play() {
    video?.play();
  },
  pause() {
    video?.pause();
  },
  togglePlay() {
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  },
};