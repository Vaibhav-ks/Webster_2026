// A tiny handle to the preview <video>, so any component can seek or play
// without passing refs around. Phase 2 replaces <video> with a canvas renderer
// behind the same functions.

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
  seek(t) {
    if (video) video.currentTime = t;
  },
  togglePlay() {
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  },
};
