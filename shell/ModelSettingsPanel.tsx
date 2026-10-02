import { useEffect, useRef, useState } from 'react';
import type { ModelSettingsState } from '../shared/contracts';
import { useModelSettings } from './useModelSettings';

export function ModelSettingsPanel({ changed }: { changed: (state: ModelSettingsState) => void }) {
  const settings = useModelSettings();
  const initialized = useRef(false); const [open, setOpen] = useState(true);
  const [model, setModel] = useState(''); const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [key, setKey] = useState(''); const [persist, setPersist] = useState(false);
  useEffect(() => {
    if (!settings.state) return;
    if (!initialized.current) { setOpen(!settings.state.hasKey); initialized.current = true; }
    else if (!settings.state.hasKey) setOpen(true);
    setModel(settings.state.model); setBaseUrl(settings.state.baseUrl); setKey('');
    setPersist(settings.state.persisted);
    changed(settings.state);
  }, [settings.state, changed]);
  const dirty = !!key || model !== settings.state?.model || baseUrl !== settings.state?.baseUrl || persist !== settings.state?.persisted;
  return <details className="ai-settings" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>模型连接 <span>{settings.state?.hasKey ? '已配置' : '未配置'}</span></summary>
    <form className="ai-form" onSubmit={event => { event.preventDefault(); void settings.save(model, baseUrl, key, persist); }}>
      <p className="ai-hint">Responses 接口，配置在当前 DreamEdge 的工程窗口间共享。</p>
      <label>服务地址<input type="url" value={baseUrl} disabled={settings.busy || !settings.state} onChange={event => setBaseUrl(event.target.value)} required /></label>
      <label>模型名称<input value={model} disabled={settings.busy || !settings.state} onChange={event => setModel(event.target.value)} placeholder="填写服务提供的模型名称" maxLength={120} required /></label>
      <label>API Key<input type="password" value={key} disabled={settings.busy || !settings.state} onChange={event => setKey(event.target.value)}
        autoComplete="new-password" placeholder={settings.state?.hasKey ? '已设置，留空保留' : '填写 API Key'} maxLength={4096} required={!settings.state?.hasKey} /></label>
      <label className="ai-checkbox"><input type="checkbox" checked={persist} disabled={settings.busy || !settings.state?.secureStorageSupported}
        onChange={event => setPersist(event.target.checked)} />在本机加密保存</label>
      <p className="ai-hint">加密保存可能需要系统授权；不勾选时仅本次运行使用。</p>
      {!settings.state?.secureStorageSupported && <p className="ai-hint">此设备不支持系统加密保存，配置仅在本次运行生效。</p>}
      <div className="ai-buttons">
        <button className="ai-button" type="submit" disabled={settings.busy || !settings.state}>保存配置</button>
        <button className="ai-button" type="button" disabled={settings.busy || dirty || !settings.state?.hasKey} onClick={() => { void settings.test(); }}>测试连接</button>
        <button className="ai-button" type="button" disabled={settings.busy || !settings.state?.hasKey} onClick={() => { void settings.clear(); }}>清除配置</button>
      </div>
      <p className="ai-hint">测试会发送少量文本，不包含工程源码，可能产生模型服务费用。</p>
      {settings.busy && <p role="status">正在处理模型配置…</p>}
      {settings.notice && <p role="status">{settings.notice}</p>}
      {settings.state?.warning && <p role="alert" className="sidebar-error">{settings.state.warning}</p>}
      {settings.error && <p role="alert" className="sidebar-error">{settings.error}</p>}
    </form>
  </details>;
}
