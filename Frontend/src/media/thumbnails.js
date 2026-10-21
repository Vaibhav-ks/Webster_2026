// Filmstrip thumbnails for the timeline's video track. Uses its own hidden <video>
// so it never disturbs the preview. Frames are taken coarse-to-fine (every 8th, then
// every 4th, …) so the whole strip fills in quickly and sharpens as more arrive.

import { useEditorStore } from '../store/useEditorStore.js';

const THUMB_H = 72;

export async function generateThumbnails(videoUrl, duration) {
  if (!duration || !Number.isFinite(duration)) return;
  const count = Math.max(8, Math.min(90, Math.ceil(duration / 1.5)));
  const times = Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * duration);

  const order = [];
  const seen = new Set();
  for (let stride = 8; stride >= 1; stride /= 2) {
    for (let i = 0; i < count; i += stride) if (!seen.has(i)) (seen.add(i), order.push(i));
  }

  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.src = videoUrl;
  try {
    await once(video, 'loadeddata');
  } catch {
    return;
  }

  const w = Math.max(1, Math.round((THUMB_H * video.videoWidth) / (video.videoHeight || 1)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext('2d');

  for (const i of order) {
    // Stop if the user loaded another video meanwhile.
    if (useEditorStore.getState().videoUrl !== videoUrl) break;
    video.currentTime = times[i];
    try {
      await once(video, 'seeked');
    } catch {
      break;
    }
    ctx.drawImage(video, 0, 0, w, THUMB_H);
    const url = canvas.toDataURL('image/jpeg', 0.7);
    if (useEditorStore.getState().videoUrl !== videoUrl) break;
    useEditorStore.getState().addThumbnail({ t: times[i], url });
  }

  video.removeAttribute('src');
  video.load();
}

function once(el, event) {
  return new Promise((resolve, reject) => {
    const ok = () => (cleanup(), resolve());
    const bad = () => (cleanup(), reject(new Error('media error')));
    const cleanup = () => {
      el.removeEventListener(event, ok);
      el.removeEventListener('error', bad);
    };
    el.addEventListener(event, ok);
    el.addEventListener('error', bad);
  });
}

/** Loudness envelope for the waveform: peak |sample| per 10 ms bin, normalized to 0..1. */
export function computePeaks(samples, sampleRate) {
  const bin = Math.max(1, Math.round(sampleRate / 100));
  const n = Math.ceil(samples.length / bin);
  const peaks = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    let p = 0;
    const end = Math.min(samples.length, (i + 1) * bin);
    for (let j = i * bin; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > p) p = v;
    }
    peaks[i] = p;
    if (p > max) max = p;
  }
  if (max > 0) for (let i = 0; i < n; i++) peaks[i] = Math.sqrt(peaks[i] / max); // sqrt lifts quiet speech
  return peaks;
}