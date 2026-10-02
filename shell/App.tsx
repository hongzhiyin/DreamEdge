import { useEffect, useRef, useState } from 'react';
import type { AppManifest } from '../shared/contracts';
import { useToolBridge } from './bridge';
import { DevelopmentSidebar } from './DevelopmentSidebar';

export function App() {
  const [application, setApplication] = useState<AppManifest>();
  const [error, setError] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  useToolBridge(frame, application);
  useEffect(() => {
    const load = () => window.dreamEdge.tools().then(tools => {
      setApplication(tools[0] as AppManifest);
      setError('');
    }).catch(() => setError('应用无法加载，请重启后再试。'));
    void load();
    return window.dreamEdge.onContextChanged(() => { void load(); });
  }, []);
  return <div className="application-root">
    {error && <p role="alert">{error}</p>}
    {application?.projectView?.status === 'loading' && <div className="application-status"><p role="status">正在加载已保存的工程…</p></div>}
    {application?.projectView?.status === 'failed' && <div className="application-status">
      <p role="alert">工程无法显示：{application.projectView.error}</p>
      <button onClick={() => { void window.dreamEdge.reloadProjectView().catch(() => setError('重新加载失败，请检查工程后重试。')); }}>重新加载工程</button>
    </div>}
    {application && (!application.projectView || application.projectView.status === 'ready') && <iframe key={application.contextId} ref={frame} title={`${application.name}内容`}
      src={`dreamedge://${application.id}/${application.entry}`}
      sandbox="allow-scripts allow-same-origin allow-forms" />}
    {application?.capabilities.includes('workspace') && <DevelopmentSidebar />}
  </div>;
}
