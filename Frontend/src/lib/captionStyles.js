// Subtitle styles. Plain data, read by drawCaption() in captions.js, which runs in both
// the preview (main thread) and the exporter (Web Worker). Only system fonts are used,
// because a worker's OffscreenCanvas can't see web fonts loaded by the page, and the
// preview and the export must look the same.
//
// Sizes are fractions of the frame's shorter side, so a style looks the same at any
// resolution and in landscape or portrait.

const HEAVY = '"Arial Black", "Helvetica Neue", Arial, sans-serif';
const BOLD = '"Helvetica Neue", Arial, sans-serif';

/**
 * Style fields:
 *   font, weight, size      font stack, CSS weight, font size (fraction of shorter side)
 *   upper, stripPunct       text transforms
 *   color, activeColor      word fill; the currently spoken word's fill
 *   spokenColor             fill for words already spoken in this caption (karaoke); null = color
 *   futureAlpha             opacity of words not yet spoken (0 = reveal word by word)
 *   stroke, strokeWidth     outline colour; width as a fraction of the font size
 *   shadow                  { color, blur, y } (fractions of the font size) or null
 *   box                     { color, padX, padY, radius } behind the whole caption, or null
 *   wordBox                 { color, padX, padY, radius } behind the active word, or null
 *   pop                     extra scale for the active word (0.15 = 15% bigger), animated in
 *   lineHeight              line spacing (multiple of the font size)
 */
export const CAPTION_STYLES = [
  {
    id: 'classic',
    name: 'Classic',
    font: BOLD,
    weight: 700,
    size: 0.064,
    upper: false,
    stripPunct: false,
    color: '#ffffff',
    activeColor: '#ffffff',
    spokenColor: null,
    futureAlpha: 1,
    stroke: '#000000',
    strokeWidth: 0.14,
    shadow: { color: 'rgba(0,0,0,0.55)', blur: 0.18, y: 0.05 },
    box: null,
    wordBox: null,
    pop: 0,
    lineHeight: 1.22,
  },
  {
    id: 'boxed',
    name: 'Boxed',
    font: BOLD,
    weight: 700,
    size: 0.06,
    upper: false,
    stripPunct: false,
    color: '#ffffff',
    activeColor: '#ffd84d',
    spokenColor: null,
    futureAlpha: 1,
    stroke: null,
    strokeWidth: 0,
    shadow: null,
    box: { color: 'rgba(0,0,0,0.68)', padX: 0.45, padY: 0.25, radius: 0.28 },
    wordBox: null,
    pop: 0,
    lineHeight: 1.28,
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    font: HEAVY,
    weight: 900,
    size: 0.066,
    upper: false,
    stripPunct: false,
    color: '#ffffff',
    activeColor: '#ffd400',
    spokenColor: '#ffd400',
    futureAlpha: 1,
    stroke: '#000000',
    strokeWidth: 0.16,
    shadow: { color: 'rgba(0,0,0,0.5)', blur: 0.15, y: 0.05 },
    box: null,
    wordBox: null,
    pop: 0,
    lineHeight: 1.2,
  },
  {
    id: 'pop',
    name: 'Pop',
    font: HEAVY,
    weight: 900,
    size: 0.074,
    upper: true,
    stripPunct: true,
    color: '#ffffff',
    activeColor: '#3dff7a',
    spokenColor: null,
    futureAlpha: 1,
    stroke: '#000000',
    strokeWidth: 0.2,
    shadow: { color: 'rgba(0,0,0,0.6)', blur: 0.1, y: 0.08 },
    box: null,
    wordBox: null,
    pop: 0.15,
    lineHeight: 1.12,
  },
  {
    id: 'highlight',
    name: 'Highlight',
    font: HEAVY,
    weight: 900,
    size: 0.064,
    upper: false,
    stripPunct: false,
    color: '#ffffff',
    activeColor: '#ffffff',
    spokenColor: null,
    futureAlpha: 1,
    stroke: '#000000',
    strokeWidth: 0.12,
    shadow: null,
    box: null,
    wordBox: { color: '#e0313a', padX: 0.2, padY: 0.1, radius: 0.22 },
    pop: 0.06,
    lineHeight: 1.3,
  },
  {
    id: 'reveal',
    name: 'Reveal',
    font: BOLD,
    weight: 800,
    size: 0.066,
    upper: false,
    stripPunct: false,
    color: '#ffffff',
    activeColor: '#ffffff',
    spokenColor: null,
    futureAlpha: 0,
    stroke: null,
    strokeWidth: 0,
    shadow: { color: 'rgba(0,0,0,0.85)', blur: 0.3, y: 0.06 },
    box: null,
    wordBox: null,
    pop: 0.1,
    lineHeight: 1.22,
  },
];

export const DEFAULT_STYLE_ID = 'karaoke';

export function getCaptionStyle(id) {
  return CAPTION_STYLES.find((s) => s.id === id) ?? CAPTION_STYLES.find((s) => s.id === DEFAULT_STYLE_ID);
}
