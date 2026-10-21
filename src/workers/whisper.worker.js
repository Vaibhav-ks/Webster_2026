// Whisper speech-to-text in a Web Worker (FR-2), so the UI never freezes.
//
// Messages in:  { type: 'transcribe', audio: Float32Array, sampleRate }
// Messages out: { type: 'device', device }
//               { type: 'model-progress', progress }        0..1 while downloading the model
//               { type: 'transcribe-progress', progress }   0..1 over audio chunks
//               { type: 'result', words: [{ id, text, start, end }] }
//               { type: 'error', message }
//
// The model is downloaded once and then cached by the browser (Cache Storage), so the
// second load is fast and works offline.

import { pipeline } from '@huggingface/transformers';
import { WHISPER_MODEL, WHISPER_LANGUAGE, SILENCE_RMS } from '../lib/config.js';
import { chunkAudio, rms } from '../lib/chunkAudio.js';

let transcriber = null;
let device = null;

async function hasWebGPU() {
  try {
    return Boolean(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

/** Track download progress across all model files and report one number. */
function makeProgressReporter() {
  const files = new Map();
  return (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files.set(p.file, { loaded: p.loaded, total: p.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    self.postMessage({ type: 'model-progress', progress: total ? loaded / total : 0 });
  };
}

async function loadModel() {
  if (transcriber) return transcriber;
  const progress_callback = makeProgressReporter();

  if (await hasWebGPU()) {
    try {
      transcriber = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
        device: 'webgpu',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        progress_callback,
      });
      device = 'webgpu';
    } catch (err) {
      console.warn('[whisper] WebGPU failed, falling back to WASM', err);
    }
  }
  if (!transcriber) {
    transcriber = await pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback,
    });
    device = 'wasm';
  }
  self.postMessage({ type: 'device', device });
  return transcriber;
}

async function transcribe(audio, sampleRate) {
  const model = await loadModel();
  const chunks = chunkAudio(audio, sampleRate);
  const words = [];
  self.postMessage({ type: 'transcribe-progress', progress: 0 });

  for (let i = 0; i < chunks.length; i++) {
    const { start, end } = chunks[i];
    const offset = start / sampleRate;
    const chunkEnd = end / sampleRate;

    // Skip silent chunks: Whisper tends to invent text for silence or music.
    if (rms(audio, start, end) >= SILENCE_RMS) {
      const out = await model(audio.subarray(start, end), {
        return_timestamps: 'word',
        language: WHISPER_LANGUAGE,
        task: 'transcribe',
      });

      for (const c of out.chunks ?? []) {
        const text = c.text.trim();
        if (!text) continue;
        const [s, e] = c.timestamp;
        const wStart = offset + (s ?? 0);
        const wEnd = Math.min(chunkEnd, offset + (e ?? chunkEnd - offset));
        if (wEnd <= wStart) continue;
        words.push({ id: `w${words.length}`, text, start: wStart, end: wEnd });
      }
    }
    self.postMessage({ type: 'transcribe-progress', progress: (i + 1) / chunks.length });
  }

  return words;
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'transcribe') return;
  try {
    const words = await transcribe(data.audio, data.sampleRate);
    self.postMessage({ type: 'result', words });
  } catch (err) {
    console.error('[whisper]', err);
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
