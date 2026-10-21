import { useEffect, useRef } from 'react';
import { useEditorStore } from '../store/useEditorStore.js';
import { nextPlayableTime } from '../lib/edl.js';
import { findWordIndexAt } from '../lib/transcript.js';
import { player } from '../media/player.js';

/**
 * Phase 1 preview: a plain <video> plus a requestAnimationFrame loop that
 *  - jumps over removed ranges while playing (skip playback), and
 *  - updates the active word for transcript highlighting.
 * Phase 2: replace with the canvas compositor (aspect ratios, subtitles, overlays)
 * and WebAudio scheduling for glitch-free cuts.
 */
export default function VideoPreview() {
  const videoRef = useRef(null);
  const videoUrl = useEditorStore((s) => s.videoUrl);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    player.attach(video);

    let raf = 0;
    const tick = () => {
      const { removedRanges, duration, words, setActiveWordId } = useEditorStore.getState();
      const t = video.currentTime;

      if (!video.paused) {
        const next = nextPlayableTime(t, removedRanges, duration);
        if (next === null) {
          video.pause(); // everything after here is cut
        } else if (next !== t) {
          video.currentTime = next + 0.001;
        }
      }

      const i = findWordIndexAt(words, video.currentTime);
      setActiveWordId(i >= 0 ? words[i].id : null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      player.detach(video);
    };
  }, [videoUrl]);

  if (!videoUrl) return null;
  return (
    <div className="overflow-hidden rounded-xl bg-black">
      <video ref={videoRef} src={videoUrl} controls playsInline className="mx-auto max-h-[60vh] w-full" />
    </div>
  );
}
