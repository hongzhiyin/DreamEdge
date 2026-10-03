import { AppWindow, FolderOpen, FolderPlus } from 'lucide-react';
import type { ProjectAction } from '../shared/contracts';

const actions = [
  { action: 'createProject', label: '新建工程', detail: '创建独立的工程目录', icon: FolderPlus },
  { action: 'openProject', label: '打开工程', detail: '选择已有的 DreamEdge 工程', icon: FolderOpen },
  { action: 'new', label: '新窗口', detail: '打开一个独立的空白窗口', icon: AppWindow },
] as const;
export function ProjectActions({ busy, run }: { busy: ProjectAction | null; run: (action: ProjectAction) => Promise<void> }) {
  return <nav className="sidebar-actions" aria-label="工程操作" aria-busy={busy !== null}>
    {actions.map(({ action, label, detail, icon: Icon }) => <button key={action} disabled={busy !== null}
      className="sidebar-action" onClick={() => { void run(action); }}>
      <Icon aria-hidden="true" size={20} strokeWidth={1.75} />
      <span><span className="sidebar-action-label">{label}</span><span className="sidebar-action-detail">{detail}</span></span>
    </button>)}
  </nav>;
}
