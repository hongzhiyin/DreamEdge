import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, PanelRightClose, PanelRightOpen, Settings } from 'lucide-react';
import type { ProjectAction, ProjectWindow } from '../shared/contracts';
import { ProjectActions } from './ProjectActions';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import './sidebar.css';
import './ai.css';
import './chat.css';

export function DevelopmentSidebar() {
  const [open, setOpen] = useState(false); const [settingsOpen, setSettingsOpen] = useState(false);
  const [current, setCurrent] = useState<ProjectWindow>();
  const [busy, setBusy] = useState<ProjectAction | null>(null);
  const [error, setError] = useState(''); const [loadError, setLoadError] = useState('');
  const toggle = useRef<HTMLButtonElement>(null); const close = useRef<HTMLButtonElement>(null);
  const settings = useRef<HTMLButtonElement>(null); const back = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false); const pending = useRef(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const result = await window.dreamEdge.windows({ operation: 'current' }) as ProjectWindow;
        if (alive) { setCurrent(result); setLoadError(''); }
      } catch (error) { if (alive) setLoadError(error instanceof Error ? error.message : '无法读取工程状态。'); }
    };
    void load();
    const unsubscribe = window.dreamEdge.onContextChanged(() => { void load(); });
    return () => { alive = false; unsubscribe(); };
  }, []);
  useEffect(() => { setSettingsOpen(false); }, [current?.project?.id]);
  useEffect(() => {
    const target = open ? close.current : wasOpen.current ? toggle.current : null;
    const frame = requestAnimationFrame(() => target?.focus()); wasOpen.current = open;
    return () => cancelAnimationFrame(frame);
  }, [open]);
  function showSettings(value: boolean) {
    setSettingsOpen(value);
    requestAnimationFrame(() => (value ? back.current : settings.current)?.focus());
  }
  async function run(action: ProjectAction) {
    if (pending.current) return;
    pending.current = true; setBusy(action); setError('');
    try { await window.dreamEdge.projectAction(action); }
    catch (error) { setError(error instanceof Error ? error.message : '工程操作失败，请重试。'); }
    finally { pending.current = false; setBusy(null); }
  }
  const feedback = busy || error || loadError || current?.recoveryError;
  return <div className="development-controls">
    <button ref={toggle} className="sidebar-toggle icon-button" hidden={open}
      aria-label="打开开发侧栏" title="打开开发侧栏" aria-expanded={open} aria-controls="development-sidebar"
      onClick={() => setOpen(true)}><PanelRightOpen aria-hidden="true" size={20} strokeWidth={1.75} /></button>
    <aside id="development-sidebar" className={`development-sidebar${open ? ' is-open' : ''}`}
      aria-label="开发侧栏" aria-hidden={!open} inert={!open}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
      <header className="sidebar-header">
        {settingsOpen && <button ref={back} className="icon-button" aria-label="返回 AI 对话" title="返回 AI 对话" onClick={() => showSettings(false)}><ArrowLeft size={19} strokeWidth={1.75} aria-hidden="true" /></button>}
        <div className="sidebar-title"><h1>{settingsOpen ? '工程设置' : 'AI 对话'}</h1><p className="sidebar-project-name">{current?.project?.name ?? '未打开工程'}</p></div>
        <div className="sidebar-header-actions">
          {!settingsOpen && <button ref={settings} className="icon-button" aria-label="打开工程设置" title="工程设置" onClick={() => showSettings(true)}><Settings size={19} strokeWidth={1.75} aria-hidden="true" /></button>}
          <button ref={close} className="icon-button" aria-label="收起开发侧栏" title="收起开发侧栏"
            aria-expanded={open} aria-controls="development-sidebar" onClick={() => setOpen(false)}><PanelRightClose aria-hidden="true" size={20} strokeWidth={1.75} /></button>
        </div>
      </header>
      {feedback && <div className="sidebar-feedback" aria-live="polite">
        {busy && <p role="status">{busy === 'new' ? '正在打开新窗口…' : '正在选择工程…'}</p>}
        {[error, loadError, current?.recoveryError].filter(Boolean).map((message, index) => <p key={index} role="alert" className="sidebar-error">{message}</p>)}
      </div>}
      {current?.project ? <WorkspaceSidebar key={current.project.id} projectId={current.project.id} settingsOpen={settingsOpen}
        embedded={!!current.embedded} directory={current.project.rootDirectory} openSettings={() => showSettings(true)} busy={busy} run={run} /> : <div className="sidebar-welcome">
        <h2>{settingsOpen ? '工程管理' : '从一个工程开始'}</h2><p className="sidebar-hint">新建或打开工程，与 AI 一起开发你的应用。</p>
        <ProjectActions busy={busy} run={run} />
      </div>}
    </aside>
  </div>;
}
