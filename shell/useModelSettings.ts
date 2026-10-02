import { useEffect, useRef, useState } from 'react';
import type { ModelConnection, ModelSettingsState } from '../shared/contracts';

export function useModelSettings() {
  const [state, setState] = useState<ModelSettingsState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true); const pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    const load = async () => {
      try {
        const value = await window.dreamEdge.modelSettings({ operation: 'get' }) as ModelSettingsState;
        if (alive.current) setState(value);
      } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '无法读取模型配置。'); }
    };
    void load(); const stop = window.dreamEdge.onModelSettingsChanged(() => { void load(); });
    return () => { alive.current = false; stop(); };
  }, []);
  async function action(run: () => Promise<void>) {
    if (pending.current || !state) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await run(); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '模型配置操作失败。'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  const save = (model: string, baseUrl: string, apiKey: string, persist: boolean) => action(async () => {
    const value = await window.dreamEdge.modelSettings({ operation: 'save', model, baseUrl, apiKey, persist, expectedRevision: state!.revision }) as ModelSettingsState;
    if (alive.current) { setState(value); setNotice(value.persisted ? '模型配置已在本机加密保存。' : '模型配置已设置，仅本次运行使用。'); }
  });
  const test = () => action(async () => {
    const value = await window.dreamEdge.modelSettings({ operation: 'test', expectedRevision: state!.revision }) as ModelConnection;
    if (alive.current) { if (value.available) setNotice(value.detail); else setError(value.detail); }
  });
  const clear = () => action(async () => {
    const value = await window.dreamEdge.modelSettings({ operation: 'clear', expectedRevision: state!.revision }) as ModelSettingsState;
    if (alive.current) { setState(value); setNotice('模型配置已清除。'); }
  });
  return { state, busy, error, notice, save, test, clear };
}
