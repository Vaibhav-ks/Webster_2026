import { useEffect, useRef } from 'react';
import { useSubtitleStore, POSITION_PRESETS } from '../store/useSubtitleStore.js';
import { CAPTION_STYLES } from '../lib/captionStyles.js';
import { drawCaption, SAMPLE_PAGE } from '../lib/captions.js';
import * as I from './icons.jsx';

/**
 * Subtitle settings, floating over the preview: on/off, style, size, position, words per
 * caption. While it's open the preview shows a draggable frame around the subtitles
 * (with a sample line when nobody is speaking at the playhead).
 */
export default function SubtitlePanel() {
  const open = useSubtitleStore((s) => s.panelOpen);
  const s = useSubtitleStore();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && s.setPanelOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, s]);

  if (!open) return null;
  const preset = Object.entries(POSITION_PRESETS).find(([, p]) => Math.abs(p.x - s.x) < 1e-3 && Math.abs(p.y - s.y) < 1e-3)?.[0];

  return (
    <div
      className="panel fade-up absolute right-3 top-3 z-30 flex max-h-[calc(100%-96px)] w-[300px] flex-col overflow-hidden text-fg"
      // Keep clicks and drags in here from reaching the video (play/pause, subtitle drag).
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="rounded-[4px] border-[1.5px] border-current px-[3px] text-[9px] font-bold leading-[13px]">CC</span>
        <h3 className="text-sm font-semibold">Subtitles</h3>
        <Switch checked={s.enabled} onChange={() => s.toggle()} label="Show subtitles" />
        <button
          type="button"
          onClick={() => s.setPanelOpen(false)}
          className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg"
          aria-label="Close subtitle settings"
        >
          <I.X />
        </button>
      </div>

      <div className={`min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 ${s.enabled ? '' : 'pointer-events-none opacity-40'}`}>
        <section>
          <Label>Style</Label>
          <div className="grid grid-cols-2 gap-2">
            {CAPTION_STYLES.map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => s.update({ styleId: st.id })}
                className={`overflow-hidden rounded-xl border text-left transition-all ${
                  s.styleId === st.id ? 'border-accent ring-2 ring-accent/40' : 'border-line hover:border-line-strong'
                }`}
                aria-pressed={s.styleId === st.id}
              >
                <StylePreview style={st} />
                <span className="block px-2 py-1 text-[11px] font-medium">{st.name}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <Label value={`${Math.round(s.scale * 100)}%`}>Size</Label>
          <input
            type="range"
            min={0.5}
            max={2.5}
            step={0.05}
            value={s.scale}
            onChange={(e) => s.update({ scale: Number(e.target.value) })}
            className="w-full accent-[var(--c-accent)]"
            aria-label="Subtitle size"
          />
        </section>

        <section>
          <Label>Position</Label>
          <div className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-sunken p-1">
            {Object.entries(POSITION_PRESETS).map(([name, p]) => (
              <button
                key={name}
                type="button"
                onClick={() => s.update(p)}
                className={`rounded-lg py-1 text-xs font-medium capitalize transition-colors ${
                  preset === name ? 'bg-raised text-fg shadow' : 'text-muted hover:text-fg'
                }`}
              >
                {name}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-subtle">Or drag the subtitles in the preview. Drag the corner square to resize.</p>
        </section>

        <section>
          <Label value={s.maxWords}>Words per caption</Label>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={s.maxWords}
            onChange={(e) => s.update({ maxWords: Number(e.target.value) })}
            className="w-full accent-[var(--c-accent)]"
            aria-label="Words per caption"
          />
        </section>

        <div className="flex items-center justify-between border-t border-line pt-3 text-[11px] text-subtle">
          <span>Burned into the export.</span>
          <button type="button" onClick={() => s.resetLayout()} className="font-medium text-muted hover:text-fg">
            Reset position &amp; size
          </button>
        </div>
      </div>
    </div>
  );
}

function Label({ children, value }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between text-xs font-semibold text-muted">
      <span>{children}</span>
      {value != null && <span className="font-mono tabular-nums text-subtle">{value}</span>}
    </div>
  );
}

function Switch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-line-strong'}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

/** The sample line drawn with the real renderer, so the cards look exactly like the output. */
function StylePreview({ style }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 132;
    const H = 58;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#3b4252');
    g.addColorStop(1, '#1b1f27');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Size the sample to fill the card regardless of the style's base size.
    drawCaption(ctx, SAMPLE_PAGE, 0.55, style, { x: 0.5, y: 0.5, scale: 0.21 / style.size }, W, H);
  }, [style]);
  return <canvas ref={ref} className="block h-[58px] w-full" style={{ width: '100%', height: 58 }} />;
}
