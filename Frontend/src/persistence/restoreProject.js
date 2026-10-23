// Put a saved project back into the editor using the editor's own pipeline:
// validateFile -> readVideoMetadata -> loadMedia -> thumbnails -> audio peaks + energy ->
// setTranscript(words) -> removedRanges / undo history.
//
// Whisper is NOT re-run: the saved transcript is the original one. Every check that can
// fail happens before the store is touched, so a bad file or damaged project never
// leaves the editor half-loaded and never resets saved cuts.

import { useEditorStore } from '../store/useEditorStore.js';
import { validateFile, readVideoMetadata, extractAudio } from '../media/extractAudio.js';
import { generateThumbnails, computePeaks } from '../media/thumbnails.js';
import { computeEnergy } from '../lib/acoustics.js';
import { WHISPER_SAMPLE_RATE } from '../lib/config.js';
import { prepareRestore, RestoreError } from './projectState.js';

/**
 * @param {{ file: File, detail: { project, transcript, editorState } }} args  detail = GET /projects/:id
 * @returns {Promise<{ historyDropped: boolean }>}
 */
export async function loadSavedProject({ file, detail }) {
  const invalid = validateFile(file);
  if (invalid) throw new RestoreError('SOURCE_UNSUPPORTED', invalid);

  const videoUrl = URL.createObjectURL(file);
  let meta;
  let prepared;
  try {
    meta = await readVideoMetadata(videoUrl);
    prepared = prepareRestore({
      words: detail.transcript?.words,
      editorState: detail.editorState,
      schemaVersion: detail.project.schemaVersion,
      savedDuration: detail.project.source?.durationS,
      loadedDuration: meta.duration,
    });
  } catch (err) {
    URL.revokeObjectURL(videoUrl);
    throw err instanceof RestoreError ? err : new RestoreError('SOURCE_UNREADABLE', err.message);
  }

  // From here on, the same steps ingestFile() takes, minus transcription.
  const store = useEditorStore.getState();
  store.loadMedia({ file, videoUrl, ...meta });
  generateThumbnails(videoUrl, meta.duration).catch((e) => console.warn('thumbnails', e));

  store.setStatus('extracting', 'Rebuilding waveform…');
  try {
    const audio = await extractAudio(file);
    if (useEditorStore.getState().videoUrl === videoUrl) {
      useEditorStore.getState().setPeaks(computePeaks(audio, WHISPER_SAMPLE_RATE));
      useEditorStore.getState().setEnergy(computeEnergy(audio, WHISPER_SAMPLE_RATE));
    }
  } catch (err) {
    // The waveform and energy are aids; the transcript and cuts are what matter.
    // Filler detection falls back to transcript-only rules without energy.
    console.warn('waveform', err);
  }
  if (useEditorStore.getState().videoUrl !== videoUrl) {
    throw new RestoreError('CANCELLED', 'Another video was opened while this project was loading.');
  }

  useEditorStore.getState().setTranscript(prepared.words); // derives gaps/items, status 'ready'
  useEditorStore.setState({
    removedRanges: prepared.removedRanges,
    past: prepared.past,
    future: prepared.future,
  });
  return { historyDropped: prepared.historyDropped };
}