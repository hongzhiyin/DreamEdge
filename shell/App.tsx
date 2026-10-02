import { useEffect, useRef, useState } from 'react';
import type { AppManifest } from '../shared/contracts';
import { useToolBridge } from './bridge';

export function App() {
  const [application, setApplication] = useState<AppManifest>();
  const [error, setError] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  useToolBridge(frame, application);
  useEffect(() => {
    window.dreamEdge.info().then(info => {
      document.title = info.name;
      setApplication(info);
    }).catch(() => setError('应用无法加载，请重启后再试。'));
  }, []);
  return <div className="application-root">
    {error && <p role="alert">{error}</p>}
    {application && <iframe ref={frame} title={`${application.name}内容`}
      src={`dreamedge://${application.id}/${application.entry}`}
      sandbox="allow-scripts allow-same-origin allow-forms" />}
  </div>;
}
