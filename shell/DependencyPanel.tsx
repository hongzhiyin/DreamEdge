import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useCandidateBuild } from './useCandidateBuild';
import './dependencies.css';

const phase = { resolving: '解析依赖', installing: '安装依赖', compiling: '构建中', complete: '构建完成' };
export function DependencyPanel({ projectId }: { projectId: string }) {
  const build = useCandidateBuild(projectId);
  const progress = useRef<HTMLDivElement>(null);
  useEffect(() => { if (build.record) progress.current?.scrollIntoView({ block: 'nearest' }); }, [build.record?.id]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [name, setName] = useState(''); const [version, setVersion] = useState('');
  const [formError, setFormError] = useState('');
  useEffect(() => { if (build.project) setDraft(build.project.definition.dependencies); }, [build.project]);
  const running = build.record?.status === 'running';
  const disabled = build.busy || running || !build.project;
  const changed = JSON.stringify(Object.entries(draft).sort()) !== JSON.stringify(Object.entries(build.project?.definition.dependencies ?? {}).sort());
  const success = build.record?.status === 'succeeded';
  const matches = JSON.stringify(Object.entries(draft).sort()) === JSON.stringify(Object.entries(build.record?.dependencies ?? {}).sort());
  function add() {
    const packageName = name.trim(); const packageVersion = version.trim();
    if (!packageName || !packageVersion) { setFormError('请填写包名和准确版本。'); return; }
    if (Object.keys(draft).length >= 20 && !Object.hasOwn(draft, packageName)) { setFormError('最多支持 20 个直接依赖。'); return; }
    setDraft({ ...draft, [packageName]: packageVersion }); setName(''); setVersion(''); setFormError('');
  }
  return <section className="dependency-panel" aria-label="依赖与构建">
    <h2>依赖与构建</h2>
    <p className="dependency-hint">填写 npm 包名和准确版本。先构建预览，确认后保存到工程。</p>
    <ul className="dependency-list" aria-label="工程依赖">
      {Object.entries(draft).map(([name, version]) => <li key={name}>
        <span><strong>{name}</strong><span className="dependency-version">{version}</span></span>
        <button className="icon-button" disabled={disabled} aria-label={`移除 ${name}`} onClick={() => {
          const next = { ...draft }; delete next[name]; setDraft(next);
        }}><X size={16} strokeWidth={1.75} aria-hidden="true" /></button>
      </li>)}
    </ul>
    {!Object.keys(draft).length && <p className="dependency-hint">当前没有外部依赖。</p>}
    <form onSubmit={event => { event.preventDefault(); add(); }} className="dependency-form">
      <label>包名<input value={name} disabled={disabled} onChange={event => setName(event.target.value)} placeholder="例如 react" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
      <label>版本<input value={version} disabled={disabled} onChange={event => setVersion(event.target.value)} placeholder="例如 19.2.0" autoCapitalize="off" spellCheck={false} /></label>
      <button type="submit" disabled={disabled} className="dependency-button"><Plus size={16} aria-hidden="true" />添加依赖</button>
    </form>
    {formError && <p role="alert" className="sidebar-error">{formError}</p>}
    {changed && <p className="dependency-hint">依赖修改尚未保存。</p>}
    {!changed && build.project?.definition.dependencyLock && <p className="dependency-hint">已锁定 {Object.keys(build.project.definition.dependencyLock.packages).length} 个依赖包。</p>}
    <div className="dependency-buttons">
      <button className="dependency-button primary" disabled={disabled} onClick={() => { void build.start(draft); }}>构建候选</button>
      {running && <button className="dependency-button" disabled={build.busy} onClick={() => { void build.cancel(); }}>取消构建</button>}
      {success && !build.saved && <>
        <button className="dependency-button" disabled={build.busy || !matches} onClick={() => { void build.preview(); }}>预览候选</button>
        <button className="dependency-button" disabled={build.busy || !matches} onClick={() => { void build.confirm(); }}>确认保存</button>
      </>}
    </div>
    <button className="dependency-clear" disabled={disabled} onClick={() => { void build.clearCache(); }}>清理依赖缓存</button>
    <div ref={progress} className="dependency-progress" aria-live="polite">
      {running && <p role="status">{phase[build.record!.phase]}…</p>}
      {build.saved && <p role="status">已保存，依赖已随工程版本锁定。</p>}
      {build.busy && !running && <p role="status">正在处理…</p>}
      {build.record && !running && !build.saved && !build.busy && <p role="status">{success ? matches ? '构建成功，请预览并确认保存。' : '依赖已变化，请重新构建。' : build.record.status === 'cancelled' ? '构建已取消，原工程未修改。' : '构建未完成，原工程未修改。'}</p>}
      {build.record && <ol className="dependency-logs" aria-label="构建日志">
        {build.record.logs.slice(-3).map((log, index) => <li key={index} className={log.level === 'error' ? 'dependency-log-error' : ''}>{log.message}</li>)}
      </ol>}
      {build.notice && <p role="status">{build.notice}</p>}
      {build.error && <p role="alert" className="sidebar-error">{build.error}</p>}
    </div>
  </section>;
}
