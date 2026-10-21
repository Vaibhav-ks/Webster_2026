import { useRef, useState } from 'react';
import { ingestFile } from '../media/ingest.js';
import { useEditorStore } from '../store/useEditorStore.js';
import ThemeToggle from './ThemeToggle.jsx';
import { Logo } from './Toolbar.jsx';
import * as I from './icons.jsx';

const FEATURES = [
  { icon: I.Text, title: 'Edit by text', body: 'Delete words in the transcript and the video follows.' },
  { icon: I.Magnet, title: 'Word-accurate timeline', body: 'Every cut and seek snaps to word edges, never mid-word.' },
  { icon: I.Shield, title: 'Private by design', body: 'Whisper and export run on your device. Nothing uploads.' },
];

export default function UploadPanel() {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const error = useEditorStore((s) => s.error);

  const handleFiles = (files) => {
    const file = files?.[0];
    if (file) ingestFile(file);
  };

  return (
    <div className="ambient relative flex h-full flex-col overflow-y-auto">
      <header className="flex items-center justify-between px-6 py-4">
        <Logo />
        <ThemeToggle />
      </header>

      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-2xl text-center">
          <span className="fade-up inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/70 px-3 py-1 text-xs font-medium text-muted backdrop-blur">
            <I.Sparkle className="text-accent" /> Text-driven video editing, in your browser
          </span>
          <h1 className="fade-up mt-5 text-4xl font-extrabold tracking-tight sm:text-6xl" style={{ animationDelay: '60ms' }}>
            Cut video like
            <br />
            <span className="bg-gradient-to-r from-scarlet-400 via-scarlet-500 to-amber-400 bg-clip-text text-transparent">
              you edit text.
            </span>
          </h1>
          <p className="fade-up mx-auto mt-4 max-w-md text-muted" style={{ animationDelay: '120ms' }}>
            Upload a clip, get a word-level transcript, and delete what you don&apos;t need. The timeline, transcript and
            preview stay in lockstep.
          </p>

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFiles(e.dataTransfer.files);
            }}
            style={{ animationDelay: '180ms' }}
            className={`fade-up group relative mt-10 w-full overflow-hidden rounded-3xl border-2 border-dashed px-6 py-14 transition-all duration-300 ${
              dragging
                ? 'scale-[1.01] border-accent bg-accent-soft'
                : 'border-line-strong bg-surface/60 backdrop-blur hover:border-accent/60 hover:bg-surface'
            }`}
          >
            <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100 [background:radial-gradient(30rem_12rem_at_50%_0%,var(--glow),transparent)]" />
            <div
              className={`float relative mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-scarlet-400 to-scarlet-700 text-2xl text-white shadow-[0_14px_36px_-10px_var(--glow)]`}
            >
              <I.Upload />
            </div>
            <div className="relative mt-5 text-lg font-semibold">
              {dragging ? 'Drop to start editing' : 'Drop a video here, or click to choose'}
            </div>
            <div className="relative mt-1 text-sm text-subtle">MP4, WebM or MOV · your video never leaves this device</div>
          </button>

          <input
            ref={inputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />

          {error && (
            <p
              className="fade-up mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500 dark:text-red-300"
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="mt-10 grid gap-3 text-left sm:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }, i) => (
              <div
                key={title}
                className="panel fade-up p-4 transition-transform duration-300 hover:-translate-y-0.5"
                style={{ animationDelay: `${260 + i * 70}ms` }}
              >
                <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent-soft text-accent">
                  <Icon />
                </div>
                <div className="mt-3 text-sm font-semibold">{title}</div>
                <div className="mt-1 text-xs leading-relaxed text-muted">{body}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}