// Split long audio into Whisper-sized chunks, cutting at the quietest moment
// so that words are not sliced in half at chunk boundaries.

import { CHUNK_MAX_S, CHUNK_MIN_S } from './config.js';

export function rms(samples, from = 0, to = samples.length) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** Returns [{ start, end }] in sample indices. */
export function chunkAudio(samples, sampleRate, maxS = CHUNK_MAX_S, minS = CHUNK_MIN_S) {
  const max = Math.floor(maxS * sampleRate);
  const min = Math.floor(minS * sampleRate);
  const frame = Math.floor(0.02 * sampleRate); // 20 ms analysis frames
  const chunks = [];
  let start = 0;

  while (start < samples.length) {
    if (samples.length - start <= max) {
      chunks.push({ start, end: samples.length });
      break;
    }
    let cut = start + max;
    let quietest = Infinity;
    for (let f = start + min; f + frame <= start + max; f += frame) {
      const e = rms(samples, f, f + frame);
      if (e < quietest) {
        quietest = e;
        cut = f + (frame >> 1);
      }
    }
    chunks.push({ start, end: cut });
    start = cut;
  }
  return chunks;
}
