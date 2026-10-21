import { useRef, useState } from 'react';
import { ingestFile } from '../media/ingest.js';
import { useEditorStore } from '../store/useEditorStore.js';

export default function UploadPanel() {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const error = useEditorStore((s) => s.error);

  const handleFiles = (files) => {
    const file = files?.[0];
    if (file) ingestFile(file);
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-xl text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          The <span className="text-scarlet-500">Scarlet</span> Rewrite
        </h1>
        <p className="mt-2 text-zinc-400">Edit video by editing its transcript. Everything runs in your browser.</p>

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
          className={`mt-8 w-full rounded-2xl border-2 border-dashed px-6 py-16 transition ${
            dragging ? 'border-scarlet-500 bg-scarlet-500/10' : 'border-zinc-700 hover:border-zinc-500'
          }`}
        >
          <div className="text-lg font-medium">Drop a video here or click to choose</div>
          <div className="mt-1 text-sm text-zinc-500">MP4, WebM or MOV · your video never leaves this device</div>
        </button>

        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />

        {error && (
          <p className="mt-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
