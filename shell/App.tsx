import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Layers2, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import type { ToolManifest } from '../shared/contracts';
import { useToolBridge } from './bridge';
import { AiPanel } from './AiPanel';

export function App() {
  const [tools, setTools] = useState<ToolManifest[]>([]);
  const [error, setError] = useState('');
  const [aiOpen, setAiOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const aiButton = useRef<HTMLButtonElement>(null);
  const tool = tools[0];
  const toggleAi = useCallback(() => setAiOpen(open => !open), []);
  useToolBridge(frame, tool, toggleAi);

  function loadTools() {
    setError('');
    window.dreamEdge.tools().then(items => { setTools(items); document.title = items[0]?.name ?? 'DreamEdge'; }).catch(() => setError('工具列表无法加载，请重试。'));
  }
  useEffect(loadTools, []);
  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setAiOpen(open => !open);
      }
      if (event.key === 'Escape' && aiOpen) closeAi();
    }
    window.addEventListener('keydown', shortcuts);
    return () => window.removeEventListener('keydown', shortcuts);
  }, [aiOpen]);
  function closeAi() { setAiOpen(false); aiButton.current?.focus(); }

  return <div className="app-layout">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Layers2 size={23} /></span><span>{tool?.name ?? '加载中'}<small>独立应用工作区</small></span></div>
      <div className="nav-label">当前应用 <span>{tools.length.toString().padStart(2, '0')}</span></div>
      {tools.map(item => <div key={item.id} className="tool-nav" aria-label="当前应用">
        <Layers2 size={19} /><span>{item.name}<small>{item.description}</small></span>
      </div>)}
      <div className="sidebar-note"><span className="small-line" /><p>由 DreamEdge 提供<br />运行与开发能力。</p></div>
      <div className="local-status"><ShieldCheck size={17} /><div>本地工作空间<small>应用数据保存在本机</small></div></div>
    </aside>
    <div className="workspace">
      <header className="workspace-header">
        <div className="breadcrumb">当前应用 <ChevronRight size={14} /><strong>{tool?.name ?? '加载中'}</strong><span className="version">v{tool?.version ?? '0.1.0'}</span></div>
        <div className="header-actions"><button className="icon-button" aria-label="重新加载工具" onClick={() => setReload(value => value + 1)}><RefreshCw size={17} /></button>
          <button ref={aiButton} className="ai-toggle" onClick={() => setAiOpen(open => !open)} aria-expanded={aiOpen}><Sparkles size={16} />AI 助手<kbd>⌘ K</kbd></button></div>
      </header>
      <main className="tool-workspace">
        {error && <div className="host-error" role="alert"><p>{error}</p><button onClick={loadTools}>重试</button></div>}
        {tool && <iframe key={`${tool.id}-${reload}`} ref={frame} title={`${tool.name}工具`} src={`dreamedge://${tool.id}/${tool.entry}`}
          sandbox="allow-scripts allow-same-origin allow-forms" />}
        {aiOpen && <AiPanel toolName={tool?.name ?? '阅读记录'} onClose={closeAi} />}
      </main>
    </div>
  </div>;
}
