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
let spanWatch = 0;

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
  /**
   * Play a short window around [start, end] (for reviewing a filler candidate), then
   * pause. If the user seeks away meanwhile, stop watching without pausing.
   */
  playSpan(start, end, lead = 1, tail = 0.6) {
    if (!video) return;
    cancelAnimationFrame(spanWatch);
    const from = Math.max(0, start - lead);
    const stopAt = end + tail;
    video.currentTime = from;
    video.play();
    const watch = () => {
      if (!video || video.paused) return;
      const t = video.currentTime;
      if (t < from - 0.25 || t > stopAt + 2) return; // user took over
      if (t >= stopAt) {
        video.pause();
        return;
      }
      spanWatch = requestAnimationFrame(watch);
    };
    spanWatch = requestAnimationFrame(watch);
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