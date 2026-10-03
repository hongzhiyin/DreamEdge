import { useEffect, useRef, useState } from 'react';
import type { WorkspaceProject, WorkspaceStatus } from '../shared/contracts';
import { definitionRevision } from './project-settings';

export function ProjectNamePanel({ projectId, locked }: { projectId: string; locked: boolean }) {
  const [name, setName] = useState(''); const [saved, setSaved] = useState<{ name: string; revision: string }>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const alive = useRef(true); const pending = useRef(false); const value = useRef({ name, saved }); value.current = { name, saved };
  async function load(force = false) {
    const state = await window.dreamEdge.workspace({ operation: 'current' }) as WorkspaceStatus;
    if (!alive.current || state.project?.definition.id !== projectId) return;
    const current = { name: state.project.definition.name, revision: await definitionRevision(state.project.definition) };
    if (!alive.current) return;
    const previous = value.current;
    if (!force && previous.saved && previous.name !== previous.saved.name && current.name !== previous.saved.name) {
      setError('工程名称已发生变化，请重新读取后保存。'); return;
    }
    if (force || !previous.saved || previous.name === previous.saved.name) setName(current.name);
    setSaved(current);
  }
  useEffect(() => {
    alive.current = true; const refresh = () => { if (!pending.current) void load().catch(error => { if (alive.current) setError(error.message); }); };
    refresh(); const stop = window.dreamEdge.onContextChanged(refresh);
    return () => { alive.current = false; stop(); };
  }, [projectId]);
  async function save() {
    if (pending.current || locked || !saved) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const project = await window.dreamEdge.workspace({ operation: 'save', projectId, name, expectedDefinitionHash: saved.revision }) as WorkspaceProject;
      if (alive.current) { setName(project.definition.name); setSaved({ name: project.definition.name, revision: await definitionRevision(project.definition) }); setNotice('工程名称已保存，窗口标题已更新。'); }
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '保存工程名称失败。'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <section aria-label="工程名称设置">
    <form className="ai-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>工程名称<input value={name} required maxLength={80} disabled={busy || locked || !saved} onChange={event => setName(event.target.value)} /></label>
      <p className="ai-hint">用于窗口标题和侧栏，不移动工程目录；导出应用的名称在“应用与导出”中单独设置。</p>
      <div className="ai-buttons"><button className="ai-button" disabled={busy || locked || !saved || !name.trim() || name === saved.name}>保存工程名称</button>
        <button type="button" className="ai-button" disabled={busy} onClick={() => { void load(true).catch(error => setError(error.message)); }}>重新读取工程名称</button></div>
      {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="sidebar-error">{error}</p>}
    </form>
  </section>;
}
