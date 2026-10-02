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
    }).catch(() => setError('应用无法加载，请重启后再试。'));
    void load();
    return window.dreamEdge.onContextChanged(() => { void load(); });
  }, []);
  return <div className="application-root">
    {error && <p role="alert">{error}</p>}
    {application && <iframe key={application.contextId} ref={frame} title={`${application.name}内容`}
      src={`dreamedge://${application.id}/${application.entry}`}
      sandbox="allow-scripts allow-same-origin allow-forms" />}
    {application?.capabilities.includes('workspace') && <DevelopmentSidebar />}
  </div>;
}
