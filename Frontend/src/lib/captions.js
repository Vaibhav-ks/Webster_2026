// Subtitles: group the kept words into short captions ("pages"), find what's on screen
// at a time, and lay out / draw a caption on any 2D canvas context.
//
// The same drawCaption() runs in the preview (main thread, <canvas> over the video) and
// in the exporter (Web Worker, OffscreenCanvas), so what you see is what gets burned in.
// Everything is in source seconds, like the rest of the edit model. Cut words never
// appear, and captions follow the edits because they're rebuilt from removedRanges.

import { isSpanRemoved } from './edl.js';
import { overlapLength } from './ranges.js';

// ---------------------------------------------------------------------------
// Pages

/**
 * Group kept words into captions. A new caption starts when the current one has
 * `maxWords` words, gets too long, a sentence ends, or there is a real pause in the
 * *edited* video (a pause that was cut doesn't count).
 *
 * @returns {Array<{ start, end, words: Array<{ text, start, end }> }>}
 *   `end` is held up to `hold` seconds past the last word (but never into the next
 *   caption), so captions don't flicker off between phrases.
 */
export function buildCaptionPages(words, removedRanges, { maxWords = 4, breakGap = 0.6, hold = 0.5 } = {}) {
  const maxChars = Math.max(12, maxWords * 9);
  const pages = [];
  let cur = null;
  let prev = null;

  for (const w of words) {
    const text = String(w.text ?? '').trim();
    if (!text || isSpanRemoved(w, removedRanges)) continue;
    if (cur) {
      const span = { start: Math.min(prev.end, w.start), end: w.start };
      const gapOut = Math.max(0, span.end - span.start - overlapLength(span, removedRanges));
      const tooLong = cur.chars + 1 + text.length > maxChars;
      const sentenceEnd = /[.!?…]["”')\]]*$/.test(prev.text);
      if (cur.words.length >= maxWords || tooLong || gapOut > breakGap || sentenceEnd) {
        pages.push(cur);
        cur = null;
      }
    }
    if (!cur) cur = { words: [], chars: -1 };
    cur.words.push({ text, start: w.start, end: w.end });
    cur.chars += 1 + text.length;
    prev = { text, end: w.end };
  }
  if (cur) pages.push(cur);

  return pages.map((p, i) => {
    const start = p.words[0].start;
    const last = p.words[p.words.length - 1].end;
    const next = pages[i + 1]?.words[0].start ?? Infinity;
    return { start, end: Math.max(last, Math.min(next, last + hold)), words: p.words };
  });
}

/** The caption on screen at time t, or null. Binary search; `pages` sorted by start. */
export function findPageAt(pages, t) {
  let lo = 0;
  let hi = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pages[mid];
    if (t < p.start) hi = mid - 1;
    else if (t >= p.end) lo = mid + 1;
    else return p;
  }
  return null;
}

/** Index of the word being spoken (the last one that has started), or -1 before the first. */
export function activeWordIndex(page, t) {
  let idx = -1;
  for (let i = 0; i < page.words.length; i++) {
    if (page.words[i].start <= t) idx = i;
    else break;
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Layout

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function captionFontPx(style, settings, W, H) {
  return Math.max(6, Math.min(W, H) * style.size * (settings.scale ?? 1));
}

export function displayText(text, style) {
  let t = text;
  if (style.stripPunct) t = t.replace(/^["“'(]+/u, '').replace(/[.,!?;:…"”')]+$/u, '');
  if (style.upper) t = t.toUpperCase();
  return t || text;
}

/**
 * Wrap the caption into lines no wider than 90% of the frame and place it centred on
 * (settings.x, settings.y), kept fully inside the frame.
 * @returns {{ fontPx, lineH, cx, top, lines: Array<{ width, words: Array<{ i, text, width, slot, x }> }>,
 *             box: { x, y, w, h } }}   box = the caption's outer bounds in canvas pixels
 */
export function layoutCaption(ctx, page, style, settings, W, H) {
  const fontPx = captionFontPx(style, settings, W, H);
  ctx.font = `${style.weight} ${fontPx}px ${style.font}`;
  const space = ctx.measureText(' ').width;
  const padX = style.box ? style.box.padX * fontPx : 0;
  const padY = style.box ? style.box.padY * fontPx : 0;
  const maxW = W * 0.9 - 2 * padX;

  // Each word gets a slot wide enough for its popped-out size and its highlight box, so
  // the active word never runs into its neighbours.
  // 60% is enough: the pop is brief and the outline hides a touch of overlap; full
  // reservation leaves visibly wide gaps.
  const extra = (width) => 0.6 * (width * (style.pop || 0) + (style.wordBox ? 2 * style.wordBox.padX * fontPx : 0));

  const lines = [];
  let line = { width: 0, words: [] };
  page.words.forEach((w, i) => {
    const text = displayText(w.text, style);
    const width = ctx.measureText(text).width;
    const slot = width + extra(width);
    if (line.words.length && line.width + space + slot > maxW) {
      lines.push(line);
      line = { width: 0, words: [] };
    }
    const x = line.words.length ? line.width + space : 0;
    line.words.push({ i, text, width, slot, x });
    line.width = x + slot;
  });
  if (line.words.length) lines.push(line);

  const lineH = fontPx * style.lineHeight;
  const blockW = Math.max(0, ...lines.map((l) => l.width));
  const blockH = lines.length * lineH;
  const outerW = blockW + 2 * padX;
  const outerH = blockH + 2 * padY;

  const margin = 0.02 * Math.min(W, H);
  const cx = clamp((settings.x ?? 0.5) * W, margin + outerW / 2, W - margin - outerW / 2);
  const cy = clamp((settings.y ?? 0.82) * H, margin + outerH / 2, H - margin - outerH / 2);
  // If the caption is wider/taller than the frame, clamp() above returns the upper bound; centre it instead.
  const fx = outerW + 2 * margin > W ? W / 2 : cx;
  const fy = outerH + 2 * margin > H ? H / 2 : cy;

  return {
    fontPx,
    lineH,
    cx: fx,
    top: fy - blockH / 2,
    lines,
    box: { x: fx - outerW / 2, y: fy - outerH / 2, w: outerW, h: outerH },
  };
}

// ---------------------------------------------------------------------------
// Drawing

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

const easeOutBack = (p) => {
  const c = 1.7;
  return 1 + (c + 1) * (p - 1) ** 3 + c * (p - 1) ** 2;
};

/**
 * Draw `page` as it looks at time t. Returns the caption's bounds ({ x, y, w, h }) so
 * the preview can hit-test drags. Works with CanvasRenderingContext2D and
 * OffscreenCanvasRenderingContext2D alike.
 */
export function drawCaption(ctx, page, t, style, settings, W, H) {
  const L = layoutCaption(ctx, page, style, settings, W, H);
  const active = activeWordIndex(page, t);
  const { fontPx } = L;

  ctx.save();
  ctx.font = `${style.weight} ${fontPx}px ${style.font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  if (style.box) {
    ctx.fillStyle = style.box.color;
    roundRect(ctx, L.box.x, L.box.y, L.box.w, L.box.h, style.box.radius * fontPx);
    ctx.fill();
  }

  L.lines.forEach((line, li) => {
    const y = L.top + li * L.lineH + L.lineH / 2;
    const left = L.cx - line.width / 2;
    for (const w of line.words) {
      const state = w.i < active ? 'spoken' : w.i === active ? 'active' : 'future';
      const alpha = state === 'future' ? style.futureAlpha : 1;
      if (alpha <= 0) continue;

      let scale = 1;
      if (state === 'active' && style.pop) {
        const p = clamp((t - page.words[w.i].start) / 0.14, 0, 1);
        scale = 1 + style.pop * easeOutBack(p);
      }
      const fill =
        state === 'active' ? style.activeColor : state === 'spoken' ? (style.spokenColor ?? style.color) : style.color;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(left + w.x + w.slot / 2, y);
      if (scale !== 1) ctx.scale(scale, scale);
      const x0 = -w.width / 2;

      if (state === 'active' && style.wordBox) {
        const b = style.wordBox;
        ctx.fillStyle = b.color;
        roundRect(ctx, x0 - b.padX * fontPx, -fontPx * (0.5 + b.padY), w.width + 2 * b.padX * fontPx, fontPx * (1 + 2 * b.padY), b.radius * fontPx);
        ctx.fill();
      }
      if (style.shadow) {
        ctx.shadowColor = style.shadow.color;
        ctx.shadowBlur = style.shadow.blur * fontPx;
        ctx.shadowOffsetY = style.shadow.y * fontPx;
      }
      if (style.stroke && style.strokeWidth > 0) {
        ctx.lineWidth = style.strokeWidth * fontPx;
        ctx.strokeStyle = style.stroke;
        ctx.strokeText(w.text, x0, 0);
        ctx.shadowColor = 'transparent'; // shadow once, under the outline
      }
      ctx.fillStyle = fill;
      ctx.fillText(w.text, x0, 0);
      ctx.restore();
    }
  });

  ctx.restore();
  return L.box;
}

/** Placeholder caption for positioning when nothing is being said at the playhead. */
export const SAMPLE_PAGE = {
  start: 0,
  end: 1,
  words: [
    { text: 'Your', start: 0, end: 0.2 },
    { text: 'subtitles', start: 0.2, end: 0.5 },
    { text: 'go', start: 0.5, end: 0.6 },
    { text: 'here', start: 0.6, end: 1 },
  ],
};
