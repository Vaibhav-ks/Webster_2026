// Filler detection on deterministic fixtures. Run with: npm test
//
// These are synthetic transcripts and synthetic energy envelopes. They test the rules
// and the plumbing; they say nothing about accuracy on real recordings (see README).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFillers, buildFillerCuts, defaultSelection, tokenize, FILLER, UNCERTAIN, KEEP } from './fillers.js';
import { computeEnergy, energyProfile, spanFeatures, silenceBefore, silenceAfter, voicedRuns } from './acoustics.js';
import { addRange, normalize } from './ranges.js';
import { buildEDL, nextPlayableTime, editedDuration, sourceToOutput } from './edl.js';

/** Words from a sentence, evenly spaced: each word `dur` long, a new one every `step`. */
function words(sentence, { t0 = 0.5, step = 0.4, dur = 0.3 } = {}) {
  return sentence.split(' ').map((text, i) => ({ id: `w${i}`, text, start: t0 + i * step, end: t0 + i * step + dur }));
}

/** 10 ms energy envelope: room noise everywhere, speech level inside each word, optional extra sounds. */
function energyFor(ws, duration, { level = 0.1, noise = 0.001, extra = [], levels = {} } = {}) {
  const e = new Float32Array(Math.ceil(duration * 100)).fill(noise);
  const paint = (s, t, v) => {
    for (let i = Math.floor(s * 100); i < Math.ceil(t * 100) && i < e.length; i++) e[i] = v;
  };
  for (const w of ws) paint(w.start, w.end, levels[w.id] ?? level);
  for (const x of extra) paint(x.start, x.end, x.level ?? level);
  return e;
}

const find = (cands, text) => cands.find((c) => c.text.toLowerCase().replace(/[^a-z' -]/g, '').trim() === text);
const run = (sentence, opts = {}) => {
  const ws = opts.words ?? words(sentence, opts);
  const duration = opts.duration ?? 30;
  return detectFillers({ words: ws, duration, energy: opts.energy === true ? energyFor(ws, duration) : opts.energy ?? null });
};

// ---- 1. obvious fillers ----

test('hesitation sounds are confident fillers, with or without audio', () => {
  for (const audio of [false, true]) {
    const { candidates } = run('So um I think uh we erm should go', { energy: audio });
    for (const t of ['um', 'uh', 'erm']) assert.equal(find(candidates, t)?.label, FILLER, `${t} (audio=${audio})`);
  }
});

test('backchannels and weak interjections are not auto-removed', () => {
  const { candidates } = run('uh-huh mm-hmm Hmm, interesting. Ah, I see.');
  assert.equal(find(candidates, 'uh-huh'), undefined);
  assert.equal(find(candidates, 'mm-hmm'), undefined);
  assert.equal(find(candidates, 'hmm')?.label, UNCERTAIN);
  assert.equal(find(candidates, 'ah')?.label, UNCERTAIN);
});

test('punctuation and case do not hide a filler', () => {
  const t = tokenize([{ id: 'a', text: ' Um,', start: 0, end: 0.3 }], 5)[0];
  assert.equal(t.norm, 'um');
  assert.equal(t.punct, 'pause');
});

// ---- 2. meaningful words are preserved ----

test('"like" as a verb, comparison or noun is KEEP and never pre-selected', () => {
  for (const s of ['I like programming.', 'I would like a coffee.', 'It looks like rain.', 'Hit the like button.', 'We really like it.']) {
    const { candidates } = run(s, { energy: true });
    const like = find(candidates, 'like');
    assert.equal(like?.label, KEEP, s);
    assert.equal(defaultSelection(candidates)[like.id], undefined, s);
  }
});

test('"well", "so", "you know", "I mean", "kind of" keep their grammatical uses', () => {
  const cases = [
    ['She did it very well.', 'well'],
    ['It works as well.', 'well'],
    ['I think so.', 'so'],
    ['It was so much fun.', 'so'],
    ['Do you know what happened?', 'you know'],
    ['You know what I mean?', 'you know'],
    ['That is what I mean.', 'i mean'],
    ['It is a kind of tool.', 'kind of'],
  ];
  for (const [s, t] of cases) assert.equal(find(run(s, { energy: true }).candidates, t)?.label, KEEP, s);
});

// ---- 3. ambiguous candidates ----

test('context words need audio evidence to become FILLER', () => {
  const s = 'It was, like, huge.';
  // transcript only: the commas suggest a filler but it stays for review
  assert.equal(find(run(s).candidates, 'like').label, UNCERTAIN);

  // audio with real pauses around "like" -> FILLER
  const ws = [
    { id: 'w0', text: 'It', start: 0.5, end: 0.7 },
    { id: 'w1', text: 'was,', start: 0.75, end: 1.0 },
    { id: 'w2', text: 'like,', start: 1.4, end: 1.65 },
    { id: 'w3', text: 'huge.', start: 2.1, end: 2.5 },
  ];
  const withPauses = detectFillers({ words: ws, duration: 5, energy: energyFor(ws, 5) });
  const like = find(withPauses.candidates, 'like');
  assert.equal(like.label, FILLER);
  assert.ok(like.reasons.some((r) => r.startsWith('pause before')));

  // same words, but "like" is shouted (stressed) and has no pauses -> not FILLER
  const tight = words('It was, like, huge.', { step: 0.3, dur: 0.3 });
  const loud = detectFillers({ words: tight, duration: 5, energy: energyFor(tight, 5, { levels: { w2: 0.3 } }) });
  assert.notEqual(find(loud.candidates, 'like').label, FILLER);
});

test('hedges and adverbs are never FILLER, even with pauses', () => {
  const ws = [
    { id: 'w0', text: 'It', start: 0.5, end: 0.7 },
    { id: 'w1', text: 'is,', start: 0.75, end: 1.0 },
    { id: 'w2', text: 'kind', start: 1.5, end: 1.7 },
    { id: 'w3', text: 'of,', start: 1.7, end: 1.85 },
    { id: 'w4', text: 'basically,', start: 2.4, end: 2.9 },
    { id: 'w5', text: 'broken.', start: 3.4, end: 3.8 },
  ];
  const { candidates } = detectFillers({ words: ws, duration: 5, energy: energyFor(ws, 5) });
  assert.equal(find(candidates, 'kind of').label, UNCERTAIN);
  assert.equal(find(candidates, 'basically').label, UNCERTAIN);
});

test('clause-initial "So," and "Well," are offered for review, not removed', () => {
  const { candidates } = run('So, we started. Well, it failed.');
  assert.equal(find(candidates, 'so').label, UNCERTAIN);
  assert.equal(find(candidates, 'well').label, UNCERTAIN);
  assert.deepEqual(defaultSelection(candidates), {});
});

// ---- 4. repetitions and restarts ----

test('repeated words and restarted phrases remove the first copy', () => {
  const ws = words('I I went to the the store');
  const { candidates } = detectFillers({ words: ws, duration: 10 });
  const ii = find(candidates, 'i');
  assert.equal(ii.label, FILLER);
  assert.deepEqual([ii.start, ii.end], [ws[0].start, ws[1].start]); // first copy + the gap before the second
  assert.equal(find(candidates, 'the').label, FILLER);

  const restart = detectFillers({ words: words('I was going I was going home'), duration: 10 }).candidates;
  const phrase = find(restart, 'i was going');
  assert.equal(phrase.kind, 'repetition');
  assert.deepEqual(phrase.wordIds, ['w0', 'w1', 'w2']);
  assert.equal(phrase.label, FILLER);
});

test('a hesitation between the copies is its own candidate, not swallowed', () => {
  const ws = words('the um the cat');
  const { candidates } = detectFillers({ words: ws, duration: 10 });
  const rep = find(candidates, 'the');
  const um = find(candidates, 'um');
  assert.equal(rep.end, ws[1].start); // stops where "um" starts
  assert.ok(um.start >= rep.end);
});

test('intentional doubles and repeats across sentences are for review', () => {
  assert.equal(find(run('It was very very good').candidates, 'very').label, UNCERTAIN);
  assert.equal(find(run('I know that that is wrong').candidates, 'that').label, UNCERTAIN);
  assert.equal(find(run('Yes. Yes it is').candidates, 'yes').label, UNCERTAIN);
});

test('cut-off words before the full word are fillers', () => {
  const { candidates } = run('th- the point');
  const frag = candidates.find((c) => c.kind === 'fragment');
  assert.equal(frag.label, FILLER);
});

// ---- 5. missing or inaccurate timestamps ----

test('a word without a usable timestamp is listed but cannot be cut', () => {
  const ws = words('we um go');
  ws[1] = { ...ws[1], start: NaN };
  const { candidates } = detectFillers({ words: ws, duration: 10 });
  const um = find(candidates, 'um');
  assert.equal(um.cuttable, false);
  assert.equal(um.label, UNCERTAIN);
  assert.deepEqual(buildFillerCuts(candidates, { [um.id]: true }, 10), []);
});

test('reversed or out-of-range timestamps are not cuttable', () => {
  const ws = [
    { id: 'a', text: 'um', start: 2, end: 1 },
    { id: 'b', text: 'uh', start: 12, end: 12.3 }, // after the end of a 10 s video
  ];
  const { candidates } = detectFillers({ words: ws, duration: 10 });
  assert.ok(candidates.every((c) => !c.cuttable));
});

test('a filler stretched over seconds is downgraded to review', () => {
  const ws = [
    { id: 'w0', text: 'so', start: 0.5, end: 0.8 },
    { id: 'w1', text: 'um', start: 0.8, end: 3.2 }, // Whisper stretched it across a pause
    { id: 'w2', text: 'yes', start: 3.2, end: 3.6 },
  ];
  const um = find(detectFillers({ words: ws, duration: 5 }).candidates, 'um');
  assert.equal(um.label, UNCERTAIN);
  assert.ok(um.reasons.some((r) => r.includes('longer than expected')));
});

test('no sound where the filler should be -> review, not cut', () => {
  const ws = words('we um go');
  const energy = energyFor(ws, 5);
  // silence the "um" span: the timestamp is probably wrong
  for (let i = Math.floor(ws[1].start * 100); i < Math.ceil(ws[1].end * 100); i++) energy[i] = 0.001;
  const um = find(detectFillers({ words: ws, duration: 5, energy }).candidates, 'um');
  assert.equal(um.label, UNCERTAIN);
  assert.ok(um.reasons.some((r) => r.includes('no sound')));
});

test('cuts are clipped so they never overlap neighbouring words', () => {
  const ws = [
    { id: 'w0', text: 'hello', start: 0.5, end: 1.1 },
    { id: 'w1', text: 'um', start: 1.0, end: 1.5 }, // overlaps "hello"
    { id: 'w2', text: 'there', start: 1.45, end: 2.0 }, // overlaps "um"
  ];
  const um = find(detectFillers({ words: ws, duration: 5 }).candidates, 'um');
  assert.deepEqual([um.start, um.end], [1.1, 1.45]);
});

test('a filler swallowed by its neighbours becomes uncuttable', () => {
  const ws = [
    { id: 'w0', text: 'hello', start: 0.5, end: 1.2 },
    { id: 'w1', text: 'um', start: 1.0, end: 1.21 },
    { id: 'w2', text: 'there', start: 1.21, end: 2.0 },
  ];
  const um = find(detectFillers({ words: ws, duration: 5 }).candidates, 'um');
  assert.equal(um.cuttable, false);
});

test('empty or unusable input returns no candidates', () => {
  assert.deepEqual(detectFillers({ words: [], duration: 10 }).candidates, []);
  assert.deepEqual(detectFillers({ words: words('um'), duration: 0 }).candidates, []);
  assert.deepEqual(detectFillers({ words: null, duration: 10 }).candidates, []);
});

// ---- audio-only: untranscribed sounds ----

test('voiced sound inside a pause is offered for review (never pre-selected)', () => {
  const ws = [
    { id: 'w0', text: 'So', start: 0.5, end: 0.8 },
    { id: 'w1', text: 'today', start: 2.0, end: 2.4 },
  ];
  const energy = energyFor(ws, 5, { extra: [{ start: 1.1, end: 1.5, level: 0.08 }] });
  const { candidates } = detectFillers({ words: ws, duration: 5, energy });
  const sound = candidates.find((c) => c.kind === 'sound');
  assert.ok(sound);
  assert.equal(sound.label, UNCERTAIN);
  assert.ok(sound.start >= 0.8 && sound.end <= 2.0);
  assert.ok(sound.start <= 1.1 && sound.end >= 1.5);
  assert.equal(defaultSelection(candidates)[sound.id], undefined);
});

test('quiet noise or silence inside a pause is not flagged', () => {
  const ws = [
    { id: 'w0', text: 'So', start: 0.5, end: 0.8 },
    { id: 'w1', text: 'today', start: 2.0, end: 2.4 },
  ];
  const energy = energyFor(ws, 5, { extra: [{ start: 1.1, end: 1.5, level: 0.025 }] }); // breath-level
  assert.equal(detectFillers({ words: ws, duration: 5, energy }).candidates.filter((c) => c.kind === 'sound').length, 0);
  assert.equal(detectFillers({ words: ws, duration: 5, energy: energyFor(ws, 5) }).candidates.filter((c) => c.kind === 'sound').length, 0);
});

test('flat audio (no speech/silence contrast) falls back to transcript-only', () => {
  const ws = words('it was, like, huge');
  const flat = new Float32Array(500).fill(0.05);
  const res = detectFillers({ words: ws, duration: 5, energy: flat });
  assert.equal(res.audioUsed, false);
  assert.equal(find(res.candidates, 'like').label, UNCERTAIN);
});

// ---- acoustics ----

test('computeEnergy gives RMS per 10 ms', () => {
  const sr = 16000;
  const s = new Float32Array(sr); // 1 s: first half silent, second half a 0.5-amplitude square wave
  for (let i = sr / 2; i < sr; i++) s[i] = i % 2 ? 0.5 : -0.5;
  const e = computeEnergy(s, sr);
  assert.equal(e.length, 100);
  assert.equal(e[10], 0);
  assert.ok(Math.abs(e[80] - 0.5) < 1e-6);
});

test('pause and voiced-run measurements', () => {
  const ws = [
    { id: 'a', text: 'one', start: 0.5, end: 1.0 },
    { id: 'b', text: 'two', start: 1.5, end: 2.0 },
  ];
  const energy = energyFor(ws, 3);
  const p = energyProfile(energy, ws);
  assert.ok(p && p.speech > p.noise);
  assert.ok(Math.abs(silenceBefore(energy, p, 1.5) - 0.5) < 0.011);
  assert.ok(Math.abs(silenceAfter(energy, p, 1.0) - 0.5) < 0.011);
  const f = spanFeatures(energy, p, 0.4, 1.1);
  assert.ok(Math.abs(f.coreDur - 0.5) < 0.011);
  assert.ok(f.steadiness > 0.99);
  assert.equal(voicedRuns(energy, p, 0, 3).length, 2);
});

// ---- 6/7. cut intervals ----

test('overlapping and touching selected cuts merge into valid ranges', () => {
  const cands = [
    { id: 'a', cuttable: true, start: 1.0, end: 1.5 },
    { id: 'b', cuttable: true, start: 1.4, end: 2.0 }, // overlaps a
    { id: 'c', cuttable: true, start: 2.0, end: 2.2 }, // touches b
    { id: 'd', cuttable: true, start: 5.0, end: 5.01 }, // too short
    { id: 'e', cuttable: true, start: 7, end: 6 }, // reversed
    { id: 'f', cuttable: true, start: NaN, end: 3 },
    { id: 'g', cuttable: false, start: 3, end: 4 },
  ];
  const all = Object.fromEntries(cands.map((c) => [c.id, true]));
  assert.deepEqual(buildFillerCuts(cands, all, 10), [{ start: 1.0, end: 2.2 }]);
});

test('cuts are clamped to [0, duration]', () => {
  const cands = [
    { id: 'a', cuttable: true, start: -0.2, end: 0.3 },
    { id: 'b', cuttable: true, start: 9.8, end: 10.4 },
    { id: 'c', cuttable: true, start: 10.2, end: 10.5 }, // entirely past the end
  ];
  const all = { a: true, b: true, c: true };
  assert.deepEqual(buildFillerCuts(cands, all, 10), [{ start: 0, end: 0.3 }, { start: 9.8, end: 10 }]);
});

test('detected cuts at the very start and end of the video stay in bounds', () => {
  const ws = [
    { id: 'w0', text: 'Um', start: 0, end: 0.4 },
    { id: 'w1', text: 'hello', start: 0.5, end: 1.0 },
    { id: 'w2', text: 'uh', start: 1.6, end: 2.3 }, // runs past the 2.0 s end
  ];
  const { candidates } = detectFillers({ words: ws, duration: 2.0 });
  const cuts = buildFillerCuts(candidates, defaultSelection(candidates), 2.0);
  assert.deepEqual(cuts, [{ start: 0, end: 0.4 }, { start: 1.6, end: 2.0 }]);
});

// ---- 8. preview / export consistency ----

test('preview and export read the same edit decisions after applying cuts', () => {
  const ws = words('So um I I went uh home', { t0: 0.5 });
  const duration = 5;
  const { candidates } = detectFillers({ words: ws, duration, energy: energyFor(ws, duration) });
  const cuts = buildFillerCuts(candidates, defaultSelection(candidates), duration);
  const existing = [{ start: 4.0, end: 4.5 }];
  const removed = normalize([...existing, ...cuts]);

  // Export: the EDL the export worker receives (runExport copies start/end only).
  const edl = buildEDL(removed, duration);
  const exported = edl.map((k) => ({ start: k.start, end: k.end }));
  // Preview: playback skips every removed range and never plays inside a cut.
  for (const c of cuts) {
    const mid = (c.start + c.end) / 2;
    const jump = nextPlayableTime(mid, removed, duration);
    assert.ok(jump === null || jump >= c.end - 1e-9);
    for (const k of exported) assert.ok(k.end <= c.start + 1e-9 || k.start >= c.end - 1e-9, 'kept range overlaps a cut');
  }
  // Same output length either way, and source->output time is continuous across a cut.
  const kept = exported.reduce((s, k) => s + k.end - k.start, 0);
  assert.ok(Math.abs(kept - editedDuration(removed, duration)) < 1e-9);
  const c0 = cuts[0];
  assert.ok(Math.abs(sourceToOutput(c0.start, edl) - sourceToOutput(c0.end, edl)) < 1e-9);
  // Existing manual cuts survive.
  assert.ok(removed.some((r) => r.start <= 4.0 && r.end >= 4.5));
});

test('merging with existing cuts keeps removedRanges normalized', () => {
  let removed = addRange([], { start: 1.2, end: 1.6 });
  removed = normalize([...removed, { start: 1.5, end: 2.0 }, { start: 3, end: 3.5 }]);
  assert.deepEqual(removed, [{ start: 1.2, end: 2.0 }, { start: 3, end: 3.5 }]);
});