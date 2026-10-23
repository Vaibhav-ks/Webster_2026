// Acoustic evidence for filler detection, from a short-time energy envelope.
// Pure functions: no browser APIs, so they run in Node tests on synthetic signals.
//
// Why only energy: the raw 16 kHz samples are handed to the Whisper worker (transferred,
// not copied) and are gone afterwards. Keeping them for pitch analysis would cost
// ~230 MB per hour of audio. A 10 ms RMS envelope costs ~1.4 MB per hour and still
// gives timing, pauses, loudness and "steadiness" (sustained vowels like "uhhh").
// None of these features proves a filler; fillers.js uses them as supporting evidence.

import { ENERGY_HOP_S } from './config.js';

/** RMS per hop (default 10 ms). Returns a Float32Array, one value per frame. */
export function computeEnergy(samples, sampleRate, hopS = ENERGY_HOP_S) {
  const hop = Math.max(1, Math.round(sampleRate * hopS));
  const n = Math.ceil(samples.length / hop);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const a = f * hop;
    const b = Math.min(samples.length, a + hop);
    let sum = 0;
    for (let i = a; i < b; i++) sum += samples[i] * samples[i];
    out[f] = Math.sqrt(sum / Math.max(1, b - a));
  }
  return out;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * Speaker-relative levels for this recording:
 *   noise  - 10th percentile of all frames (room tone)
 *   speech - median frame inside transcribed words
 *   voiced - threshold between "silence" and "sound"
 * Returns null when the envelope can't separate speech from silence (no audio, all
 * noise, music bed...). Callers must then fall back to transcript-only rules.
 */
export function energyProfile(energy, words, hop = ENERGY_HOP_S) {
  if (!energy || !energy.length || !words?.length) return null;
  const stride = Math.max(1, Math.floor(energy.length / 200000)); // bound the sort cost
  const all = [];
  for (let i = 0; i < energy.length; i += stride) all.push(energy[i]);
  const noise = percentile(all, 0.1);

  const inWords = [];
  for (const w of words) {
    if (!(w.end > w.start)) continue;
    const a = Math.max(0, Math.floor(w.start / hop));
    const b = Math.min(energy.length, Math.ceil(w.end / hop));
    for (let i = a; i < b; i += stride) inWords.push(energy[i]);
  }
  const speech = percentile(inWords, 0.5);
  if (!(speech > 1e-4) || speech < noise * 1.5) return null;

  const voiced = Math.max(noise * 3, speech * 0.2, 1e-4);
  return { hop, noise, speech, voiced };
}

const frameOf = (t, hop) => Math.floor(t / hop + 1e-6);

/**
 * Features of the audio inside [start, end]:
 *   relLoudness - mean RMS of voiced frames / typical speech level
 *   voicedFrac  - fraction of frames above the voiced threshold
 *   coreStart / coreEnd / coreDur - first..last voiced frame (the audible part of the word)
 *   steadiness  - 1 - coefficient of variation of voiced frames (1 = perfectly steady)
 */
export function spanFeatures(energy, profile, start, end) {
  const { hop, speech, voiced } = profile;
  const a = Math.max(0, frameOf(start, hop));
  const b = Math.min(energy.length, Math.ceil(end / hop - 1e-6));
  if (b <= a) return null;
  let first = -1;
  let last = -1;
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = a; i < b; i++) {
    const e = energy[i];
    if (e < voiced) continue;
    if (first < 0) first = i;
    last = i;
    n++;
    sum += e;
    sumSq += e * e;
  }
  const frames = b - a;
  if (!n) return { relLoudness: 0, voicedFrac: 0, coreStart: start, coreEnd: start, coreDur: 0, steadiness: 0 };
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  return {
    relLoudness: mean / speech,
    voicedFrac: n / frames,
    coreStart: first * hop,
    coreEnd: (last + 1) * hop,
    coreDur: (last + 1 - first) * hop,
    steadiness: Math.max(0, 1 - sd / mean),
  };
}

/** Length of unbroken silence ending at t (looking back at most maxS seconds). */
export function silenceBefore(energy, profile, t, maxS = 1.5) {
  const { hop, voiced } = profile;
  const from = Math.min(energy.length, frameOf(t, hop));
  const limit = Math.max(0, from - Math.round(maxS / hop));
  let i = from - 1;
  while (i >= limit && energy[i] < voiced) i--;
  return (from - 1 - i) * hop;
}

/** Length of unbroken silence starting at t (looking ahead at most maxS seconds). */
export function silenceAfter(energy, profile, t, maxS = 1.5) {
  const { hop, voiced } = profile;
  const from = Math.max(0, Math.ceil(t / hop - 1e-6));
  const limit = Math.min(energy.length, from + Math.round(maxS / hop));
  let i = from;
  while (i < limit && energy[i] < voiced) i++;
  return (i - from) * hop;
}

/**
 * Runs of voiced frames inside [start, end], allowing dropouts of up to `bridgeS`
 * (so one "uhhm" with a dip in the middle stays one run).
 */
export function voicedRuns(energy, profile, start, end, bridgeS = 0.05) {
  const { hop, voiced } = profile;
  const a = Math.max(0, Math.ceil(start / hop - 1e-6));
  const b = Math.min(energy.length, frameOf(end, hop));
  const bridge = Math.round(bridgeS / hop);
  const runs = [];
  let runStart = -1;
  let lastVoiced = -1;
  for (let i = a; i < b; i++) {
    if (energy[i] >= voiced) {
      if (runStart < 0) runStart = i;
      else if (i - lastVoiced - 1 > bridge) {
        runs.push([runStart, lastVoiced + 1]);
        runStart = i;
      }
      lastVoiced = i;
    }
  }
  if (runStart >= 0) runs.push([runStart, lastVoiced + 1]);
  return runs.map(([s, e]) => ({ start: s * hop, end: e * hop, ...spanFeatures(energy, profile, s * hop, e * hop) }));
}