import { useEffect, useState } from 'react';
import type { ModelSettingsController } from './useModelSettings';

export function ModelSettingsPanel({ settings }: { settings: ModelSettingsController }) {
  const [model, setModel] = useState(''); const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [key, setKey] = useState('');
  useEffect(() => {
    if (!settings.state) return;
    setModel(settings.state.model); setBaseUrl(settings.state.baseUrl); setKey('');
  }, [settings.state]);
  const dirty = !!key || model !== settings.state?.model || baseUrl !== settings.state?.baseUrl;
  return <section className="settings-section" aria-label="模型连接">
    <header className="settings-heading"><h2>模型连接</h2><span>{settings.state?.hasKey ? '已配置' : '未配置'}</span></header>
    <form className="ai-form" onSubmit={event => { event.preventDefault(); void settings.save(model, baseUrl, key); }}>
      <p className="ai-hint">当前工程独立配置，使用 Responses 接口。</p>
      <div className="ai-buttons">
        <button type="button" className="ai-button" disabled={settings.busy} onClick={() => { setBaseUrl('https://api.deepseek.com'); setModel('deepseek-flash'); }}>使用 DeepSeek</button>
        <button type="button" className="ai-button" disabled={settings.busy} onClick={() => { setBaseUrl('https://api.openai.com/v1'); setModel(''); }}>使用 OpenAI</button>
      </div>
      <label>服务地址<input type="url" value={baseUrl} disabled={settings.busy || !settings.state} onChange={event => setBaseUrl(event.target.value)} required /></label>
      <label>模型名称<input value={model} disabled={settings.busy || !settings.state} onChange={event => setModel(event.target.value)} placeholder="填写服务提供的模型名称" maxLength={120} required /></label>
      <label>API Key<input type="password" value={key} disabled={settings.busy || !settings.state} onChange={event => setKey(event.target.value)}
        autoComplete="new-password" placeholder={settings.state?.hasKey ? '已设置，留空保留' : '填写 API Key'} maxLength={4096} required={!settings.state?.hasKey} /></label>
      <p className="ai-hint">保存到工程内的 .dreamedge/model.json，包含可直接编辑的 API Key、模型和地址。保存时加入工程 .gitignore。</p>
      {settings.state?.configPath && <p className="ai-hint" style={{ overflowWrap: 'anywhere' }}>配置文件：{settings.state.configPath}</p>}
      {baseUrl.startsWith('https://api.openai.com') && model.toLowerCase().startsWith('deepseek') && <p className="sidebar-error" role="alert">DeepSeek 模型需要 DeepSeek 服务地址，请点击“使用 DeepSeek”。</p>}
      <div className="ai-buttons">
        <button className="ai-button" type="submit" disabled={settings.busy || !settings.state}>保存配置</button>
        <button className="ai-button" type="button" disabled={settings.busy || dirty || !settings.state?.hasKey} onClick={() => { void settings.test(); }}>测试连接</button>
        <button className="ai-button" type="button" disabled={settings.busy || !settings.state?.hasKey} onClick={() => { void settings.clear(); }}>清除配置</button>
        <button className="ai-button" type="button" disabled={settings.busy || !settings.state} onClick={() => { void settings.reload(); }}>重新读取文件</button>
      </div>
      <p className="ai-hint">测试会发送少量文本，不包含工程源码，可能产生模型服务费用。</p>
      {settings.busy && <p role="status">正在处理模型配置…</p>}
      {settings.notice && <p role="status">{settings.notice}</p>}
      {settings.state?.warning && <p role="alert" className="sidebar-error">{settings.state.warning}</p>}
      {settings.error && <p role="alert" className="sidebar-error">{settings.error}</p>}
    </form>
  </section>;
}
