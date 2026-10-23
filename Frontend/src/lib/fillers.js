// Filler-word and disfluency detection: transcript + audio energy -> labelled candidates.
// Pure functions (no React, no browser APIs), unit-tested in fillers.test.js.
//
// How a decision is made (README "Filler removal" has the full table):
//   1. Candidates come from the word list: hesitation sounds, discourse markers,
//      repeated words / restarted phrases, cut-off words, and (audio only) voiced sounds
//      inside pauses that Whisper did not transcribe.
//   2. Context rules score each candidate from its neighbours and Whisper's punctuation.
//      Grammatical uses ("I like programming", "as well", "a kind of tool") become KEEP.
//   3. Acoustic evidence (acoustics.js) adjusts the score: pauses around the word, a drawn
//      out or steady sound, loudness. It also catches bad timestamps (no sound where the
//      word is supposed to be, or a word stretched over seconds).
//   4. Score -> FILLER / UNCERTAIN / KEEP with fixed thresholds, then caps: context-
//      dependent words need audio evidence to reach FILLER, hedges and adverbs never do.
//
// Scores are rule scores, not probabilities. They are not calibrated on labelled data.

import {
  GAP_THRESHOLD,
  CUT_PAD,
  FILLER_MIN_SCORE,
  KEEP_MAX_SCORE,
  FILLER_PAUSE_S,
  FILLER_ELONGATION,
  FILLER_MAX_WORD_S,
  FILLER_MIN_CUT_S,
  SOUND_MIN_S,
  SOUND_MAX_S,
  SOUND_MAX_GAP_S,
} from './config.js';
import { energyProfile, spanFeatures, silenceBefore, silenceAfter, voicedRuns } from './acoustics.js';
import { normalize } from './ranges.js';

export const FILLER = 'FILLER';
export const UNCERTAIN = 'UNCERTAIN';
export const KEEP = 'KEEP';

// ---------------------------------------------------------------------------
// Tokens

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Whisper words -> tokens with normalized text, trailing punctuation and timing validity. */
export function tokenize(words, duration) {
  return words.map((w, i) => {
    const raw = String(w.text ?? '').trim();
    const trail = raw.match(/[^\p{L}\p{N}']+$/u)?.[0] ?? '';
    const norm = raw
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
    const fragment = /-$/.test(trail) && norm.length > 0;
    let punct = null;
    if (!fragment) {
      if (/\.\.|…/.test(trail)) punct = 'pause';
      else if (/[.!?]/.test(trail)) punct = 'end';
      else if (/[,;:—–-]/.test(trail)) punct = 'pause';
    }
    const valid = isNum(w.start) && isNum(w.end) && w.start >= 0 && w.end > w.start && w.start < duration;
    return {
      i,
      id: w.id,
      raw,
      norm,
      letters: norm.replace(/[^\p{L}]/gu, '').length,
      punct,
      fragment,
      valid,
      start: valid ? w.start : NaN,
      end: valid ? Math.min(w.end, duration) : NaN,
    };
  });
}

const STRONG_HESITATION = /^(u+h*m+|u+h+|e+r+m+)$/; // um, umm, uhm, uh, uhh, erm
const WEAK_HESITATION = /^(e+r+|a+h+|e+h+|h+m+|m{2,})$/; // er, ah, eh, hmm, mm (can be reactions)

export const hesitationStrength = (norm) =>
  STRONG_HESITATION.test(norm) ? 'strong' : WEAK_HESITATION.test(norm) ? 'weak' : null;

const set = (s) => new Set(s.split(' '));
const SUBJECT = set("i you we they he she it who people i'd you'd we'd they'd he'd she'd i'll you'll we'll they'll");
const AUX = set("would wouldn't do don't does doesn't did didn't to might may will won't can can't could couldn't should gonna wanna");
const SUBJ_ADVERB = set('really also still just actually always never');
const COMPARE = set('look looks looked looking seem seems seemed sound sounds sounded feel feels felt something anything nothing more less much exactly act acts acted smell smells taste tastes');
const DET = set('a an the my your his her our their');
const COPULA = set("was were is 's it's i'm am be being he's she's that's");
const CONJ = set('and but so or because cause');
const OBJ_PRONOUN = set('this that me you him her us them it these those');
const NUMBERS = set('one two three four five six seven eight nine ten twenty thirty forty fifty hundred thousand million a few couple');
const WELL_KEEP_BEFORE = set("as very pretty quite so really too fairly extremely reasonably do does did doing done went go goes going work works worked working sleep slept eat ate play played sell sold perform performed get getting feel feeling");
const WELL_KEEP_AFTER = set('known done being written made paid established worth');
const SO_KEEP_BEFORE = set('and or think hope guess believe say said not do did ever');
const SO_KEEP_AFTER = set('much many far that long what called often few little sorry');
const KNOW_OBJECT = set('what how why when where who whether that if the a an him her them it this these those me about nothing anything something someone everything more enough exactly my your his our their');
const YOU_KNOW_KEEP_BEFORE = set("do don't did didn't if as would wouldn't now who what how");
const I_MEAN_KEEP_BEFORE = set("what which do did don't if");
const I_MEAN_OBJECT = set('it that this what to the a an you him her them every no yes');
const KIND_DET = set("a an the this that what which any some every one no these those all same my your our their his her its different other another each");
/** Words people repeat on purpose: "that that", "had had", "very very", "no no". */
const LEGIT_DOUBLE = set('that had is very really no so bye yeah yes ha now well okay ok go long many much more far');

// ---------------------------------------------------------------------------
// Context rules. Each returns { score, reasons, cap?, grammatical? } for tokens[i..i+len-1].

function makeContext(tokens) {
  const norm = (k) => tokens[k]?.norm ?? null;
  const gapBefore = (k) => (k > 0 && tokens[k].valid && tokens[k - 1].valid ? tokens[k].start - tokens[k - 1].end : 0);
  const gapAfter = (k) => (k < tokens.length - 1 && tokens[k].valid && tokens[k + 1].valid ? tokens[k + 1].start - tokens[k].end : 0);
  return {
    norm,
    clauseStart: (k) => k === 0 || Boolean(tokens[k - 1].punct) || tokens[k - 1].fragment || gapBefore(k) >= FILLER_PAUSE_S,
    clauseEnd: (k) => k === tokens.length - 1 || tokens[k].punct === 'end' || gapAfter(k) >= FILLER_PAUSE_S,
    commaBefore: (k) => k > 0 && tokens[k - 1].punct === 'pause',
    commaAfter: (k) => tokens[k].punct === 'pause',
    isHesitation: (k) => Boolean(tokens[k] && hesitationStrength(tokens[k].norm)),
  };
}

const keep = (reason, score = 0.1) => ({ score, reasons: [reason], grammatical: true });

function ruleLike(c, i) {
  const p1 = c.norm(i - 1);
  const p2 = c.norm(i - 2);
  const n1 = c.norm(i + 1);
  if (SUBJECT.has(p1)) return keep(`verb: "${p1} like …"`);
  if (AUX.has(p1)) return keep(`verb: "${p1} like …"`);
  if (SUBJ_ADVERB.has(p1) && SUBJECT.has(p2)) return keep(`verb: "${p2} ${p1} like …"`);
  if (COMPARE.has(p1)) return keep(`comparison: "${p1} like …"`);
  if (DET.has(p1)) return keep(`noun: "${p1} like"`);
  if (OBJ_PRONOUN.has(n1) && !c.commaAfter(i) && !CONJ.has(p1)) return keep(`comparison: "like ${n1}"`, 0.25);

  let score = 0.4;
  const reasons = [];
  if (COPULA.has(p1)) reasons.push(`after "${p1}": may be quoting or comparing ("he was like…")`);
  if (c.commaBefore(i) && c.commaAfter(i)) (score += 0.3), reasons.push('set off by commas: ", like,"');
  else if (c.commaAfter(i)) (score += 0.15), reasons.push('followed by a comma');
  else if (c.commaBefore(i)) (score += 0.1), reasons.push('after a comma');
  if (CONJ.has(p1)) (score += 0.1), reasons.push(`after "${p1}"`);
  if (c.clauseStart(i) && !CONJ.has(p1)) (score += 0.1), reasons.push('starts a clause');
  if (c.isHesitation(i + 1)) (score += 0.15), reasons.push('followed by a hesitation');
  if (NUMBERS.has(n1) || /^\d/.test(n1 ?? '')) (score -= 0.1), reasons.push('before a number: may mean "about"');
  if (!reasons.length) reasons.push('"like" without a clear grammatical role');
  return { score, reasons };
}

function ruleWell(c, i) {
  const p1 = c.norm(i - 1);
  const n1 = c.norm(i + 1);
  if (WELL_KEEP_BEFORE.has(p1)) return keep(`adverb: "${p1} well"`);
  if (DET.has(p1)) return keep(`noun: "${p1} well"`);
  if (WELL_KEEP_AFTER.has(n1)) return keep(`"well ${n1}"`);
  if (c.clauseStart(i)) {
    let score = 0.5;
    const reasons = ['"Well" opening a clause'];
    if (c.commaAfter(i)) (score += 0.15), reasons.push('followed by a comma');
    return { score, reasons };
  }
  if (c.commaBefore(i) && c.commaAfter(i)) return { score: 0.55, reasons: ['set off by commas: ", well,"'] };
  return keep('mid-sentence "well" is usually an adverb', 0.2);
}

function ruleSo(c, i) {
  const p1 = c.norm(i - 1);
  const n1 = c.norm(i + 1);
  if (SO_KEEP_BEFORE.has(p1) && (p1 !== 'and' || n1 === 'on')) return keep(`"${p1} so"`);
  if (SO_KEEP_AFTER.has(n1)) return keep(`"so ${n1}"`);
  if (!c.clauseStart(i)) {
    if (c.clauseEnd(i)) return { score: 0.45, reasons: ['trailing "so" at the end of a clause'] };
    return keep('mid-sentence "so" usually means "very" or "therefore"', 0.2);
  }
  let score = 0.45;
  const reasons = ['"So" opening a clause (can also mean "therefore")'];
  if (c.commaAfter(i)) (score += 0.15), reasons.push('followed by a comma');
  return { score, reasons };
}

function ruleAdverb(c, i) {
  let score = 0.35;
  const reasons = [`"${c.norm(i)}" can change the meaning`];
  if (c.commaBefore(i) || c.clauseStart(i)) score += 0.1;
  if (c.commaAfter(i)) (score += 0.15), reasons.push('followed by a comma');
  return { score, reasons, cap: UNCERTAIN };
}

function ruleYouKnow(c, i) {
  const p1 = c.norm(i - 1);
  const n2 = c.norm(i + 2);
  if (YOU_KNOW_KEEP_BEFORE.has(p1)) return keep(`"${p1} you know …"`);
  if (!c.commaAfter(i + 1) && KNOW_OBJECT.has(n2)) return keep(`"you know ${n2} …": real question or statement`, 0.15);
  let score = 0.45;
  const reasons = [];
  if (c.commaAfter(i + 1)) (score += 0.2), reasons.push('followed by a comma');
  if (c.clauseEnd(i + 1)) (score += 0.15), reasons.push('tag at the end of a clause');
  if (c.clauseStart(i)) score += 0.05;
  if (!reasons.length) reasons.push('"you know" without an object');
  return { score, reasons };
}

function ruleIMean(c, i) {
  const p1 = c.norm(i - 1);
  const n2 = c.norm(i + 2);
  if (I_MEAN_KEEP_BEFORE.has(p1)) return keep(`"${p1} I mean …"`);
  if (!c.commaAfter(i + 1) && I_MEAN_OBJECT.has(n2)) return keep(`"I mean ${n2} …": clarification`, 0.25);
  let score = 0.45;
  const reasons = ['"I mean" (often starts a correction)'];
  if (c.commaAfter(i + 1)) (score += 0.2), reasons.push('followed by a comma');
  if (c.clauseStart(i)) score += 0.1;
  return { score, reasons };
}

function ruleKindOf(c, i) {
  const p1 = c.norm(i - 1);
  if (KIND_DET.has(p1)) return keep(`"${p1} ${c.norm(i)} of …" means a type of something`);
  let score = 0.45;
  const reasons = ['hedge: removing it changes the meaning'];
  if (c.commaAfter(i + 1) || c.commaBefore(i)) score += 0.15;
  return { score, reasons, cap: UNCERTAIN };
}

const PHRASES = [
  { words: ['you', 'know'], rule: ruleYouKnow },
  { words: ['i', 'mean'], rule: ruleIMean },
  { words: ['kind', 'of'], rule: ruleKindOf },
  { words: ['sort', 'of'], rule: ruleKindOf },
  { words: ['like'], rule: ruleLike },
  { words: ['well'], rule: ruleWell },
  { words: ['so'], rule: ruleSo },
  { words: ['actually'], rule: ruleAdverb },
  { words: ['basically'], rule: ruleAdverb },
  { words: ['literally'], rule: ruleAdverb },
];

// ---------------------------------------------------------------------------
// Raw candidates

function lexicalCandidates(tokens, c) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const strength = hesitationStrength(tokens[i].norm);
    if (strength) {
      out.push({
        kind: 'hesitation',
        first: i,
        last: i,
        score: strength === 'strong' ? 0.85 : 0.5,
        reasons: [strength === 'strong' ? 'hesitation sound' : `"${tokens[i].norm}" can be a filler or a reaction`],
      });
      continue;
    }
    for (const p of PHRASES) {
      const n = p.words.length;
      if (p.words.every((w, k) => tokens[i + k]?.norm === w)) {
        out.push({ kind: 'discourse', first: i, last: i + n - 1, ...p.rule(c, i) });
        break;
      }
    }
  }
  return out;
}

/** Repeated words / phrases (hesitations in between are skipped) and cut-off words. */
function repetitionCandidates(tokens) {
  const out = [];
  const seq = tokens.filter((t) => t.norm && !hesitationStrength(t.norm)).map((t) => t.i);

  for (let p = 0; p < seq.length; p++) {
    const t = tokens[seq[p]];

    // Cut-off word: "th- the", "wh- what".
    if (t.fragment && p + 1 < seq.length) {
      const next = tokens[seq[p + 1]];
      const prefix = next.norm.startsWith(t.norm);
      out.push({
        kind: 'fragment',
        first: t.i,
        last: t.i,
        score: prefix ? 0.8 : 0.55,
        reasons: [prefix ? `cut-off start of "${next.raw}"` : 'cut-off word'],
        extendToNext: true,
      });
      continue;
    }

    for (let n = 3; n >= 1; n--) {
      if (p + 2 * n > seq.length) continue;
      let same = true;
      for (let k = 0; k < n && same; k++) same = tokens[seq[p + k]].norm === tokens[seq[p + n + k]].norm;
      if (!same) continue;

      const firstCopyEnd = tokens[seq[p + n - 1]];
      const secondStart = tokens[seq[p + n]];
      const text = seq.slice(p, p + n).map((k) => tokens[k].norm).join(' ');
      let score = n >= 2 ? 0.82 : 0.8;
      let cap;
      const reasons = [n >= 2 ? `restarted phrase: "${text} ${text}"` : `repeated word: "${text} ${text}"`];
      if (n === 1 && LEGIT_DOUBLE.has(text)) (score = 0.45), reasons.push(`"${text} ${text}" is sometimes intentional`);
      if (firstCopyEnd.punct === 'end') (score = Math.min(score, 0.5)), (cap = UNCERTAIN), reasons.push('repeated across a sentence break');
      else if (firstCopyEnd.punct === 'pause') (score -= n === 1 ? 0.15 : 0.1), reasons.push('comma between the copies (may be emphasis)');
      if (firstCopyEnd.valid && secondStart.valid && secondStart.start - firstCopyEnd.end > 1.0) (score -= 0.1), reasons.push('long pause between the copies');

      out.push({ kind: 'repetition', first: seq[p], last: seq[p + n - 1], score, reasons, cap, extendToNext: true });
      p += n - 1;
      break;
    }
  }
  return out;
}

function soundCandidates(tokens, energy, profile) {
  const out = [];
  const edge = 0.05; // stay clear of the (fuzzy) word timestamps on both sides
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (!a.valid || !b.valid) continue;
    const gs = a.end;
    const ge = b.start;
    const len = ge - gs;
    if (len < 0.3 || len > SOUND_MAX_GAP_S) continue;
    const runs = voicedRuns(energy, profile, gs + edge, ge - edge);
    if (runs.length > 2) continue; // busy: music or noise, not a single vocalisation
    for (const r of runs) {
      const d = r.end - r.start;
      if (d < SOUND_MIN_S || d > SOUND_MAX_S || r.relLoudness < 0.35) continue;
      const reasons = [`${d.toFixed(2)} s of sound with no transcribed word: could be an untranscribed "um", a breath, a laugh or noise`];
      if (r.steadiness >= 0.7) reasons.push('steady, like a held vowel');
      out.push({
        kind: 'sound',
        afterIndex: i,
        start: Math.max(gs + CUT_PAD, r.start - 0.03),
        end: Math.min(ge - CUT_PAD, r.end + 0.03),
        score: 0.5,
        cap: UNCERTAIN,
        reasons,
        features: { relLoudness: r.relLoudness, steadiness: r.steadiness, voicedDur: d },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring

function median(values, fallback) {
  if (!values.length) return fallback;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export function labelFor(score, cap) {
  let label = score >= FILLER_MIN_SCORE ? FILLER : score <= KEEP_MAX_SCORE ? KEEP : UNCERTAIN;
  if (cap === UNCERTAIN && label === FILLER) label = UNCERTAIN;
  return label;
}

const fmt = (s) => `${s.toFixed(2)} s`;

/**
 * Detect filler candidates.
 * @param {{ words: Array<{id,text,start,end}>, duration: number, energy?: Float32Array|null }} input
 * @returns {{ candidates: Array<Candidate>, audioUsed: boolean }}
 *
 * Candidate: { id, kind, label, score, reasons[], wordIds[], text, before, after,
 *              start, end (the cut, in source seconds), cuttable, features }
 */
export function detectFillers({ words, duration, energy = null }) {
  if (!Array.isArray(words) || !(duration > 0)) return { candidates: [], audioUsed: false };
  const sorted = [...words].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const tokens = tokenize(sorted, duration);
  const ctx = makeContext(tokens);
  const profile = energy ? energyProfile(energy, tokens.filter((t) => t.valid)) : null;

  // Speaker's own pace: seconds per letter, from words that look normally timed.
  const perLetter = median(
    tokens.filter((t) => t.valid && t.letters >= 2 && t.letters <= 12 && t.end - t.start <= FILLER_MAX_WORD_S).map((t) => (t.end - t.start) / t.letters),
    0.07,
  );

  const raw = [...lexicalCandidates(tokens, ctx), ...repetitionCandidates(tokens)];

  // One candidate per word: keep the stronger when rules overlap ("like like" is both).
  raw.sort((a, b) => b.score - a.score);
  const taken = new Set();
  const chosen = [];
  for (const r of raw) {
    let free = true;
    for (let k = r.first; k <= r.last; k++) if (taken.has(k)) free = false;
    if (!free) continue;
    for (let k = r.first; k <= r.last; k++) taken.add(k);
    chosen.push(r);
  }

  const candidates = chosen.map((r) => finishWordCandidate(r, tokens, profile, energy, perLetter, duration));
  if (profile) {
    for (const s of soundCandidates(tokens, energy, profile)) {
      const cuttable = s.end - s.start >= FILLER_MIN_CUT_S;
      const prev = tokens[s.afterIndex];
      candidates.push({
        id: `sound-${prev.id}`,
        kind: 'sound',
        label: labelFor(s.score, s.cap),
        score: s.score,
        reasons: s.reasons,
        wordIds: [],
        text: '(sound)',
        before: contextText(tokens, s.afterIndex - 2, s.afterIndex),
        after: contextText(tokens, s.afterIndex + 1, s.afterIndex + 3),
        start: s.start,
        end: s.end,
        cuttable,
        features: s.features,
      });
    }
  }
  candidates.sort((a, b) => (isNum(a.start) ? a.start : Infinity) - (isNum(b.start) ? b.start : Infinity));
  return { candidates, audioUsed: Boolean(profile) };
}

function contextText(tokens, from, to) {
  return tokens
    .slice(Math.max(0, from), Math.max(0, to + 1))
    .map((t) => t.raw)
    .join(' ');
}

function finishWordCandidate(r, tokens, profile, energy, perLetter, duration) {
  const span = tokens.slice(r.first, r.last + 1);
  const reasons = [...r.reasons];
  let score = r.score;
  let cap = r.cap;
  let cuttable = true;
  const features = {};

  const base = {
    id: `${r.kind}-${tokens[r.first].id}`,
    kind: r.kind,
    wordIds: span.map((t) => t.id),
    text: span.map((t) => t.raw).join(' '),
    before: contextText(tokens, r.first - 3, r.first - 1),
    after: contextText(tokens, r.last + 1, r.last + 3),
  };

  // ---- timestamps ----
  if (span.some((t) => !t.valid)) {
    return {
      ...base,
      label: UNCERTAIN,
      score: Math.min(score, 0.5),
      reasons: [...reasons, 'no usable timestamp, so it cannot be cut safely'],
      start: NaN,
      end: NaN,
      cuttable: false,
      features,
    };
  }

  let start = span[0].start;
  let end = span[span.length - 1].end;
  const next = tokens[r.last + 1];
  if (r.extendToNext && next?.valid && next.start - end <= GAP_THRESHOLD) end = next.start;

  const longest = Math.max(...span.map((t) => t.end - t.start));
  if (longest > FILLER_MAX_WORD_S) {
    cap = UNCERTAIN;
    reasons.push(`timed at ${fmt(longest)}, longer than expected: the timestamp may include nearby speech`);
  }

  // ---- audio ----
  if (profile && !r.grammatical) {
    const f = spanFeatures(energy, profile, span[0].start, span[span.length - 1].end);
    if (f) {
      Object.assign(features, f);
      if (f.voicedFrac < 0.15) {
        cap = UNCERTAIN;
        reasons.push('almost no sound at this timestamp: the word may be timed wrong');
      } else if (r.kind === 'hesitation' || r.kind === 'discourse') {
        let audioEvidence = false;
        const pb = silenceBefore(energy, profile, f.coreStart);
        const pa = silenceAfter(energy, profile, f.coreEnd);
        features.pauseBefore = pb;
        features.pauseAfter = pa;
        if (pb >= FILLER_PAUSE_S) (score += 0.08), (audioEvidence = true), reasons.push(`pause before (${fmt(pb)})`);
        if (pa >= FILLER_PAUSE_S) (score += 0.08), (audioEvidence = true), reasons.push(`pause after (${fmt(pa)})`);
        if (span.length === 1 && span[0].letters > 0) {
          const ratio = f.coreDur / (perLetter * span[0].letters);
          features.elongation = ratio;
          if (ratio >= FILLER_ELONGATION && r.kind === 'discourse') {
            score += 0.1;
            audioEvidence = true;
            reasons.push(`drawn out (${ratio.toFixed(1)}× this speaker's usual length)`);
          }
        }
        if (r.kind === 'hesitation' && f.steadiness >= 0.7 && f.coreDur >= 0.15) {
          score += 0.05;
          reasons.push('steady sustained sound');
        }
        if (r.kind === 'discourse' && f.relLoudness >= 1.4) {
          score -= 0.1;
          reasons.push('louder than the surrounding speech (may be stressed)');
        }
        if (r.kind === 'discourse' && !audioEvidence) {
          cap = UNCERTAIN;
          reasons.push('no pause or drawn-out sound around it');
        }
      }
    }
  } else if (!profile && r.kind === 'discourse' && !r.grammatical) {
    cap = UNCERTAIN;
    reasons.push('audio not analysed: context words need review');
  }

  // ---- clip to the neighbours so a cut never eats into another word ----
  const prev = tokens[r.first - 1];
  if (prev?.valid) start = Math.max(start, prev.end);
  if (next?.valid) end = Math.min(end, next.start);
  start = Math.max(0, start);
  end = Math.min(duration, end);
  if (!(end - start >= FILLER_MIN_CUT_S)) {
    cuttable = false;
    cap = UNCERTAIN;
    reasons.push('overlaps the neighbouring words, so it cannot be cut cleanly');
  }

  score = Math.min(1, Math.max(0, score));
  return { ...base, label: labelFor(score, cap), score, reasons, start, end, cuttable, features };
}

// ---------------------------------------------------------------------------
// From review to edits

/** Ids pre-selected for removal: confident, cuttable, not already cut. */
export function defaultSelection(candidates) {
  const sel = {};
  for (const c of candidates) if (c.label === FILLER && c.cuttable && !c.alreadyCut) sel[c.id] = true;
  return sel;
}

/**
 * Selected candidates -> normalized source-time cuts inside [0, duration].
 * Anything malformed (NaN, reversed, too short, not cuttable) is dropped, never clamped
 * into a guess.
 */
export function buildFillerCuts(candidates, selected, duration) {
  const cuts = [];
  for (const c of candidates) {
    if (!selected?.[c.id] || !c.cuttable) continue;
    if (!isNum(c.start) || !isNum(c.end)) continue;
    const start = Math.max(0, c.start);
    const end = Math.min(duration, c.end);
    if (end - start < FILLER_MIN_CUT_S) continue;
    cuts.push({ start, end });
  }
  return normalize(cuts);
}