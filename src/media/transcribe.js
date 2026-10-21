// Promise wrapper around the Whisper worker. The worker is created once and reused,
// so the model stays in memory between files.

import { WHISPER_SAMPLE_RATE } from '../lib/config.js';

let worker = null;

function getWorker() {
  worker ??= new Worker(new URL('../workers/whisper.worker.js', import.meta.url), { type: 'module' });
  return worker;
}

/**
 * @param {Float32Array} audio 16 kHz mono samples (ownership moves to the worker)
 * @param {{ onModelProgress?, onProgress?, onDevice? }} callbacks
 * @returns {Promise<Array<{ id, text, start, end }>>}
 */
export function transcribe(audio, { onModelProgress, onProgress, onDevice } = {}) {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    w.onmessage = ({ data }) => {
      switch (data.type) {
        case 'device':
          onDevice?.(data.device);
          break;
        case 'model-progress':
          onModelProgress?.(data.progress);
          break;
        case 'transcribe-progress':
          onProgress?.(data.progress);
          break;
        case 'result':
          resolve(data.words);
          break;
        case 'error':
          reject(new Error(data.message));
          break;
      }
    };
    w.onerror = (e) => reject(new Error(e.message || 'Transcription worker crashed'));
    w.postMessage({ type: 'transcribe', audio, sampleRate: WHISPER_SAMPLE_RATE }, [audio.buffer]);
  });
}
