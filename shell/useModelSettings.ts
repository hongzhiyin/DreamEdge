import { useEffect, useRef, useState } from 'react';
import type { ModelConnection, ModelSettingsState } from '../shared/contracts';

export function useModelSettings(projectId: string) {
  const [state, setState] = useState<ModelSettingsState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true); const pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    const load = async () => {
      try {
        const value = await window.dreamEdge.modelSettings({ operation: 'get', projectId }) as ModelSettingsState;
        if (alive.current) {
          setState(previous => previous?.revision === value.revision && previous.projectId === value.projectId && previous.warning === value.warning ? previous : value);
          setLoadError('');
        }
      } catch (error) { if (alive.current) setLoadError(error instanceof Error ? error.message : '无法读取模型配置。'); }
    };
    void load(); const stop = window.dreamEdge.onModelSettingsChanged(() => { void load(); });
    const stopContext = window.dreamEdge.onContextChanged(() => { void load(); });
    return () => { alive.current = false; stop(); stopContext(); };
  }, [projectId]);
  async function action(run: () => Promise<void>) {
    if (pending.current || !state) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await run(); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '模型配置操作失败。'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  const save = (model: string, baseUrl: string, apiKey: string) => action(async () => {
    const value = await window.dreamEdge.modelSettings({ operation: 'save', projectId, model, baseUrl, apiKey, expectedRevision: state!.revision }) as ModelSettingsState;
    if (alive.current) { setState(value); setNotice('模型配置已保存到当前工程。'); }
  });
  const test = () => action(async () => {
    const value = await window.dreamEdge.modelSettings({ operation: 'test', projectId, expectedRevision: state!.revision }) as ModelConnection;
    if (alive.current) { if (value.available) setNotice(value.detail); else setError(value.detail); }
  });
  const clear = () => action(async () => {
    const value = await window.dreamEdge.modelSettings({ operation: 'clear', projectId, expectedRevision: state!.revision }) as ModelSettingsState;
    if (alive.current) { setState(value); setNotice('模型配置已清除。'); }
  });
  const reload = () => action(async () => {
    const value = await window.dreamEdge.modelSettings({ operation: 'get', projectId }) as ModelSettingsState;
    if (alive.current) { setState(value); setNotice('已重新读取工程配置文件。'); }
  });
  return { state, busy, error: error || loadError, notice, save, test, clear, reload };
}
