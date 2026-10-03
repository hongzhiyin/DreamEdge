import { useApplicationSettings } from './useApplicationSettings';
import { useProjectExport } from './useProjectExport';

const phases = { building: '构建源码', packaging: '生成独立 App', publishing: '完成导出', complete: '结束' };
export function ApplicationPanel({ projectId }: { projectId: string }) {
  const settings = useApplicationSettings(projectId); const output = useProjectExport(projectId);
  return <section className="settings-section" aria-label="应用与导出">
    <header className="settings-heading"><h2>应用信息</h2></header>
    <form className="ai-form" onSubmit={event => { event.preventDefault(); void settings.save(); }}>
      <label>应用名称<input value={settings.draft.name} maxLength={80} required disabled={settings.busy || !settings.state}
        onChange={event => settings.setDraft({ ...settings.draft, name: event.target.value })} /></label>
      <label>应用标识<input value={settings.draft.appId} maxLength={200} required spellCheck={false} disabled={settings.busy || !settings.state}
        onChange={event => settings.setDraft({ ...settings.draft, appId: event.target.value })} placeholder="io.example.myapp" /></label>
      <p className="ai-hint">不同 App 使用不同标识，决定独立安装与数据目录；同一 App 升级时保持标识不变。</p>
      <label>应用版本<input value={settings.draft.version} required disabled={settings.busy || !settings.state} placeholder="0.1.0"
        onChange={event => settings.setDraft({ ...settings.draft, version: event.target.value })} /></label>
      <div className="ai-buttons"><button className="ai-button" disabled={settings.busy || !settings.dirty || output.running}>保存应用信息</button>
        <button className="ai-button" type="button" disabled={settings.busy} onClick={() => { void settings.reload(); }}>重新读取</button></div>
      {settings.notice && <p role="status">{settings.notice}</p>}{settings.error && <p role="alert" className="sidebar-error">{settings.error}</p>}
    </form>
    <div className="ai-candidate">
      <h3>导出业务 App</h3><p className="ai-hint">生成本机 macOS App、ZIP 和源码工程；模型配置、会话、原 Git 历史与业务数据不会复制。</p>
      {output.supported === false && <p className="ai-hint">当前只支持 macOS 本机架构导出。</p>}
      {settings.dirty && <p className="ai-hint">先保存应用信息，再导出。</p>}
      <div className="ai-buttons">
        <button className="ai-button primary" disabled={!output.supported || output.running || output.busy || settings.busy || settings.dirty || !settings.state}
          onClick={() => { void output.run('start'); }}>导出 macOS App</button>
        {output.running && <button className="ai-button" disabled={output.busy || output.record?.phase === 'publishing'} onClick={() => { void output.run('cancel'); }}>取消导出</button>}
        {output.record?.status === 'succeeded' && <button className="ai-button" disabled={output.busy} onClick={() => { void output.run('reveal'); }}>在 Finder 中查看</button>}
      </div>
      {output.record && <><p role="status">{output.running ? `${phases[output.record.phase]}…` : output.record.status === 'succeeded' ? '业务 App 已导出。' : output.record.status === 'cancelled' ? '导出已取消。' : '导出未完成。'}</p>
        {output.record.status === 'succeeded' && <p className="ai-hint" style={{ overflowWrap: 'anywhere' }}>{output.record.directory}</p>}
        <details className="ai-full-source"><summary>导出日志</summary><pre className="export-logs">{output.record.logs.join('\n')}</pre></details>
        {output.record.error && <p role="alert" className="sidebar-error">{output.record.error}</p>}</>}
      {output.error && <p role="alert" className="sidebar-error">{output.error}</p>}
    </div>
  </section>;
}
