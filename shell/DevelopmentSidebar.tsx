import { useEffect, useRef, useState } from 'react';
import { AppWindow, FolderOpen, FolderPlus, PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { ModelSettingsState, ProjectAction, ProjectWindow } from '../shared/contracts';
import './sidebar.css';
import './ai.css';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { AiConversation } from './AiConversation';
import { GitPanel } from './GitPanel';

const actions = [
  { action: 'createProject', label: '新建工程', detail: '创建独立的工程目录', icon: FolderPlus },
  { action: 'openProject', label: '打开工程', detail: '选择已有的 DreamEdge 工程', icon: FolderOpen },
  { action: 'new', label: '新窗口', detail: '打开一个独立的空白窗口', icon: AppWindow },
] as const;

export function DevelopmentSidebar() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ProjectWindow>();
  const [busy, setBusy] = useState<ProjectAction | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [model, setModel] = useState<ModelSettingsState>();
  const toggle = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const pending = useRef(false);
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
  useEffect(() => {
    const target = open ? close.current : wasOpen.current ? toggle.current : null;
    const frame = requestAnimationFrame(() => target?.focus());
    wasOpen.current = open;
    return () => cancelAnimationFrame(frame);
  }, [open]);
  async function run(action: ProjectAction) {
    if (pending.current) return;
    pending.current = true; setBusy(action); setError('');
    try { await window.dreamEdge.projectAction(action); }
    catch (error) { setError(error instanceof Error ? error.message : '工程操作失败，请重试。'); }
    finally { pending.current = false; setBusy(null); }
  }
  return <div className="development-controls">
    <button ref={toggle} className="sidebar-toggle icon-button" hidden={open}
      aria-label="打开开发侧栏" title="打开开发侧栏" aria-expanded={open} aria-controls="development-sidebar"
      onClick={() => setOpen(true)}><PanelRightOpen aria-hidden="true" size={20} strokeWidth={1.75} /></button>
    <aside id="development-sidebar" className={`development-sidebar${open ? ' is-open' : ''}`}
      aria-label="开发侧栏" aria-hidden={!open} inert={!open}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
      <header className="sidebar-header">
        <h1>开发</h1>
        <button ref={close} className="icon-button" aria-label="收起开发侧栏" title="收起开发侧栏"
          aria-expanded={open} aria-controls="development-sidebar" onClick={() => setOpen(false)}>
          <PanelRightClose aria-hidden="true" size={20} strokeWidth={1.75} />
        </button>
      </header>
      <div className="sidebar-body">
        <section className="sidebar-project" aria-label="当前工程">
          <p className="sidebar-caption">当前工程</p>
          <p className="sidebar-project-name">{current?.project?.name ?? '未打开工程'}</p>
          {!current?.project && <p className="sidebar-hint">新建或打开工程，开始开发。</p>}
          {current?.recoveryError && <p role="alert" className="sidebar-error">{current.recoveryError}</p>}
        </section>
        <nav className={`sidebar-actions${current?.project ? ' is-compact' : ''}`} aria-label="工程操作" aria-busy={busy !== null}>
          {actions.map(({ action, label, detail, icon: Icon }) => <button key={action} disabled={busy !== null}
            className="sidebar-action" onClick={() => { void run(action); }}>
            <Icon aria-hidden="true" size={20} strokeWidth={1.75} />
            <span><span className="sidebar-action-label">{label}</span><span className="sidebar-action-detail">{detail}</span></span>
          </button>)}
        </nav>
        <div className="sidebar-feedback" aria-live="polite">
          {busy && <p role="status">{busy === 'new' ? '正在打开新窗口…' : '正在选择工程…'}</p>}
          {error && <p role="alert" className="sidebar-error">{error}</p>}
          {loadError && <p role="alert" className="sidebar-error">{loadError}</p>}
        </div>
        {current?.project && <ModelSettingsPanel key={current.project.id} projectId={current.project.id} changed={setModel} />}
        {current?.project && <GitPanel key={`git-${current.project.id}`} projectId={current.project.id} />}
        {current?.project && <AiConversation key={current.project.id} projectId={current.project.id}
          configured={model?.projectId === current.project.id && !!model.hasKey && !!model.model && !model.warning} />}
      </div>
    </aside>
  </div>;
}
