import { useEffect, useRef, useState } from 'react';
import { Layers2, Sparkles } from 'lucide-react';
import { ReadingLog } from '../tools/reading-log/src/ReadingLog';
import { AiPanel } from '../shell/AiPanel';
import { readingStore } from './storage';

function AssistantSheet({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="assistant-sheet" aria-label="AI 助手"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <AiPanel toolName="阅读记录" onClose={onClose} />
  </dialog>;
}

export function App() {
  const [aiOpen, setAiOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  function close() { setAiOpen(false); button.current?.focus(); }
  return <div className="mobile-root">
    <header className="mobile-header">
      <div className="mobile-brand"><Layers2 size={24} /><div>IdeaDock<small>随身的工具空间</small></div></div>
      <button ref={button} className="mobile-ai-button" onClick={() => setAiOpen(true)} aria-expanded={aiOpen} aria-label="打开 AI 助手"><Sparkles size={18} />助手</button>
    </header>
    <main><ReadingLog store={readingStore} /></main>
    {aiOpen && <AssistantSheet onClose={close} />}
  </div>;
}
