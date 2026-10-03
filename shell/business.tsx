import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ToolManifest } from '../shared/contracts';
import { useToolBridge } from './bridge';
import './shell.css';

function BusinessApp() {
  const [tool, setTool] = useState<ToolManifest>(); const [error, setError] = useState('');
  const frame = useRef<HTMLIFrameElement>(null); useToolBridge(frame, tool);
  useEffect(() => { void window.dreamEdge.tools().then(value => setTool(value[0])).catch(() => setError('应用无法加载，请重启后再试。')); }, []);
  return <div className="application-root">{error && <p role="alert">{error}</p>}
    {tool && <iframe ref={frame} title={`${tool.name}内容`} src={`dreamedge://${tool.id}/${tool.entry}`} sandbox="allow-scripts allow-same-origin allow-forms" />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<BusinessApp />);
