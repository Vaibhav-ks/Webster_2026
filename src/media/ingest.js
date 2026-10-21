// Upload -> metadata -> audio -> Whisper -> words. Drives the status shown in the UI.

import { useEditorStore } from '../store/useEditorStore.js';
import { validateFile, readVideoMetadata, extractAudio } from './extractAudio.js';
import { transcribe } from './transcribe.js';

export async function ingestFile(file) {
  const store = useEditorStore.getState();

  const invalid = validateFile(file);
  if (invalid) {
    store.reset();
    store.setError(invalid);
    return;
  }

  const videoUrl = URL.createObjectURL(file);
  try {
    const meta = await readVideoMetadata(videoUrl);
    store.loadMedia({ file, videoUrl, ...meta });

    store.setStatus('extracting', 'Extracting audio…');
    const audio = await extractAudio(file);

    store.setStatus('model', 'Loading speech model (first time only)…');
    let started = false;
    const words = await transcribe(audio, {
      onDevice: (device) => useEditorStore.getState().setDevice(device),
      onModelProgress: (p) => useEditorStore.getState().setProgress(p),
      onProgress: (p) => {
        const s = useEditorStore.getState();
        if (!started) {
          started = true;
          s.setStatus('transcribing', 'Transcribing…');
        }
        s.setProgress(p);
      },
    });

    useEditorStore.getState().setTranscript(words);
  } catch (err) {
    console.error(err);
    useEditorStore.getState().setError(err.message ?? String(err));
  }
}
