import { useEditorStore } from './store/useEditorStore.js';
import UploadPanel from './components/UploadPanel.jsx';
import Toolbar from './components/Toolbar.jsx';
import StatusBar from './components/StatusBar.jsx';
import VideoPreview from './components/VideoPreview.jsx';
import TranscriptEditor, { useTranscriptShortcuts } from './components/TranscriptEditor.jsx';

export default function App() {
  const videoUrl = useEditorStore((s) => s.videoUrl);
  if (!videoUrl) return <UploadPanel />;
  return <Editor />;
}

function Editor() {
  const status = useEditorStore((s) => s.status);
  useTranscriptShortcuts();

  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      <main className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-2">
        <section className="flex flex-col gap-4">
          <VideoPreview />
          <StatusBar />
          {/* Phase 4: <Timeline /> goes here */}
        </section>
        <section className="min-h-0 overflow-y-auto rounded-xl bg-zinc-900/60 p-5">
          {status === 'ready' ? (
            <TranscriptEditor />
          ) : (
            <p className="text-zinc-500">The transcript will appear here once transcription finishes.</p>
          )}
        </section>
      </main>
    </div>
  );
}
