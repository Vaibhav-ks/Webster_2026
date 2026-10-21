// Every tunable number in one place. Tune these on real recordings (SRS §11).

/** Silence longer than this (seconds) becomes a gap token / free cut zone. */
export const GAP_THRESHOLD = 0.5;

/** A word or gap counts as deleted when this fraction of it is inside removedRanges. */
export const DELETE_OVERLAP = 0.5;

/** Free cuts inside a gap stay this far (seconds) from neighbouring words. */
export const CUT_PAD = 0.04;

/** Sample rate Whisper expects. */
export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Whisper model. The "_timestamped" ONNX export includes the cross-attention
 * outputs needed for word-level timestamps. It is multilingual, so the same
 * model can be tried on Hinglish later by changing WHISPER_LANGUAGE.
 */
export const WHISPER_MODEL = 'onnx-community/whisper-base_timestamped';
export const WHISPER_LANGUAGE = 'english';

/** Audio is split into chunks of at most this length (Whisper's window is 30 s). */
export const CHUNK_MAX_S = 29;
/** ...and at least this length; the split point is the quietest moment between the two. */
export const CHUNK_MIN_S = 20;
/** Chunks quieter than this RMS are treated as silence and not sent to Whisper (stops hallucinations). */
export const SILENCE_RMS = 0.003;

export const ACCEPTED_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
export const ACCEPTED_EXTENSIONS = ['.mp4', '.webm', '.mov'];
