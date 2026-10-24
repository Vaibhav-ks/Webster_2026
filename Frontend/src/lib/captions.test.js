import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptionPages, findPageAt, activeWordIndex, layoutCaption, drawCaption, displayText } from './captions.js';
import { CAPTION_STYLES, getCaptionStyle } from './captionStyles.js';

const W = (id, text, start, end) => ({ id, text, start, end });
const words = [
  W('w0', 'So', 0.0, 0.2),
  W('w1', 'today', 0.3, 0.6),
  W('w2', 'we', 0.7, 0.8),
  W('w3', 'build', 0.9, 1.2),
  W('w4', 'an', 1.3, 1.4),
  W('w5', 'editor.', 1.5, 2.0),
  W('w6', 'It', 4.0, 4.2), // 2 s pause before this
  W('w7', 'works.', 4.3, 4.8),
];

/** Minimal 2D context: every character is 0.5 font-size wide. */
function fakeCtx() {
  const calls = [];
  let fontPx = 10;
  return {
    calls,
    set font(f) {
      fontPx = Number(/(\d+(\.\d+)?)px/.exec(f)[1]);
    },
    get font() {
      return `${fontPx}px`;
    },
    measureText: (s) => ({ width: s.length * fontPx * 0.5 }),
    save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, rect() {}, roundRect() {}, fill() {},
    strokeText: (s) => calls.push(['stroke', s]),
    fillText: (s) => calls.push(['fill', s]),
  };
}

test('pages: max words, sentence ends and real pauses start a new caption', () => {
  const pages = buildCaptionPages(words, [], { maxWords: 4 });
  assert.deepEqual(pages.map((p) => p.words.map((w) => w.text).join(' ')), ['So today we build', 'an editor.', 'It works.']);
});

test('pages: cut words disappear, and a pause that was cut no longer splits captions', () => {
  const cut = [{ start: 2.0, end: 4.0 }, { start: 0.3, end: 0.6 }]; // remove the pause and "today"
  const pages = buildCaptionPages(words.map((w) => (w.id === 'w5' ? { ...w, text: 'editor' } : w)), cut, { maxWords: 8 });
  assert.deepEqual(pages.map((p) => p.words.map((w) => w.text).join(' ')), ['So we build an editor It works.']);
});

test('pages hold briefly after the last word but never overlap the next caption', () => {
  const pages = buildCaptionPages(words, [], { maxWords: 4, hold: 0.5 });
  assert.equal(pages[0].end, 1.3); // held to the next caption's start (1.2 + 0.5 > 1.3)
  assert.equal(pages[1].end, 2.5); // 2.0 + 0.5, next caption starts at 4.0
  assert.equal(findPageAt(pages, 2.4), pages[1]);
  assert.equal(findPageAt(pages, 3.0), null);
  assert.equal(findPageAt(pages, 4.1), pages[2]);
});

test('active word is the last one that has started', () => {
  const [p] = buildCaptionPages(words, [], { maxWords: 4 });
  assert.equal(activeWordIndex(p, 0.0), 0);
  assert.equal(activeWordIndex(p, 0.65), 1); // between words: keep the previous one lit
  assert.equal(activeWordIndex(p, 1.25), 3);
});

test('layout wraps to the frame width and stays inside the frame', () => {
  const style = getCaptionStyle('classic');
  const page = { start: 0, end: 1, words: 'one two three four five six seven eight'.split(' ').map((t, i) => W(i, t, i, i + 1)) };
  const L = layoutCaption(fakeCtx(), page, style, { x: 0.5, y: 0.99, scale: 3 }, 640, 360);
  assert.ok(L.lines.length > 1);
  for (const l of L.lines) assert.ok(l.width <= 640 * 0.9 + 1e-9);
  assert.ok(L.box.y + L.box.h <= 360); // pushed up from the very bottom
  assert.ok(L.box.x >= 0 && L.box.x + L.box.w <= 640);
});

test('font size follows the shorter side: same look in landscape and portrait', () => {
  const style = getCaptionStyle('classic');
  const page = { start: 0, end: 1, words: [W('a', 'Hi', 0, 1)] };
  const a = layoutCaption(fakeCtx(), page, style, { scale: 1 }, 1920, 1080);
  const b = layoutCaption(fakeCtx(), page, style, { scale: 1 }, 1080, 1920);
  assert.equal(a.fontPx, b.fontPx);
});

test('reveal style hides words not spoken yet; pop style uppercases and strips punctuation', () => {
  const page = buildCaptionPages(words, [], { maxWords: 4 })[0];
  const ctx = fakeCtx();
  drawCaption(ctx, page, 0.35, getCaptionStyle('reveal'), { x: 0.5, y: 0.8, scale: 1 }, 640, 360);
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'fill').map((c) => c[1]), ['So', 'today']);
  assert.equal(displayText('editor.', getCaptionStyle('pop')), 'EDITOR');
});

test('every style draws without errors', () => {
  const page = buildCaptionPages(words, [], { maxWords: 4 })[0];
  for (const style of CAPTION_STYLES) {
    const box = drawCaption(fakeCtx(), page, 0.9, style, { x: 0.5, y: 0.8, scale: 1 }, 1280, 720);
    assert.ok(box.w > 0 && box.h > 0, style.id);
  }
});
