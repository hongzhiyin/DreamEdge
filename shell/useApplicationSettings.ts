import { useEffect, useRef, useState } from 'react';
import type { ProjectDefinition, WorkspaceProject, WorkspaceStatus } from '../shared/contracts';

export interface ApplicationFields { name: string; appId: string; version: string }
const fields = (definition: ProjectDefinition): ApplicationFields => ({ name: definition.name, appId: definition.appId, version: definition.version });
async function revision(definition: ProjectDefinition) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(definition))))).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function useApplicationSettings(projectId: string) {
  const [draft, setDraft] = useState<ApplicationFields>({ name: '', appId: '', version: '' });
  const [state, setState] = useState<{ fields: ApplicationFields; revision: string }>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const current = useRef({ draft, state }); current.current = { draft, state }; const alive = useRef(true); const pending = useRef(false);
  const dirty = !!state && JSON.stringify(draft) !== JSON.stringify(state.fields);
  async function load(force = false) {
    if (pending.current && !force) return;
    const status = await window.dreamEdge.workspace({ operation: 'current' }) as WorkspaceStatus;
    if (!alive.current || status.project?.definition.id !== projectId) return;
    const value = { fields: fields(status.project.definition), revision: await revision(status.project.definition) };
    const previous = current.current;
    if (!force && previous.state && JSON.stringify(previous.draft) !== JSON.stringify(previous.state.fields)
      && JSON.stringify(value.fields) !== JSON.stringify(previous.state.fields)) { setError('应用信息已发生变化，请重新读取后保存。'); return; }
    setState(value); if (force || !previous.state || JSON.stringify(previous.draft) === JSON.stringify(previous.state.fields)) setDraft(value.fields);
  }
  useEffect(() => {
    alive.current = true; const reload = () => { void load().catch(error => { if (alive.current) setError(error.message); }); };
    reload(); const stop = window.dreamEdge.onContextChanged(reload);
    return () => { alive.current = false; stop(); };
  }, [projectId]);
  async function save() {
    if (pending.current || !state) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const project = await window.dreamEdge.workspace({ operation: 'save', projectId, ...draft, expectedDefinitionHash: state.revision }) as WorkspaceProject;
      const value = fields(project.definition); if (alive.current) { setState({ fields: value, revision: await revision(project.definition) }); setDraft(value); setError(''); setNotice('应用信息已保存。'); }
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '保存失败。'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return { draft, setDraft, state, dirty, busy, error, notice, save, reload: () => load(true) };
}
