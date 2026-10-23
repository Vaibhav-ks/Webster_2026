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

// ---- Filler detection (src/lib/fillers.js, src/lib/acoustics.js) ----
// These are hand-set starting points, NOT values fitted on labelled data. Tune them
// with the evaluation procedure in the README before trusting them more.

/** Energy envelope hop (seconds). 10 ms matches the waveform peaks. */
export const ENERGY_HOP_S = 0.01;
/** Rule score at or above this -> FILLER (pre-selected); at or below KEEP_MAX -> KEEP. */
export const FILLER_MIN_SCORE = 0.75;
export const KEEP_MAX_SCORE = 0.3;
/** Silence (audio-verified) of at least this long counts as a pause next to a candidate. */
export const FILLER_PAUSE_S = 0.25;
/** Voiced length / expected length for its letters at or above this counts as drawn out. */
export const FILLER_ELONGATION = 2.0;
/** A single word timed longer than this is suspicious (Whisper often stretches words over pauses). */
export const FILLER_MAX_WORD_S = 1.5;
/** Cuts shorter than this are dropped (they would only produce a click). */
export const FILLER_MIN_CUT_S = 0.03;
/** Voiced sound inside a pause, with no transcribed word, between these lengths is flagged for review. */
export const SOUND_MIN_S = 0.15;
export const SOUND_MAX_S = 1.0;
/** ...only in pauses up to this long (longer ones are scene breaks, music, etc.). */
export const SOUND_MAX_GAP_S = 3;

export const ACCEPTED_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
export const ACCEPTED_EXTENSIONS = ['.mp4', '.webm', '.mov'];