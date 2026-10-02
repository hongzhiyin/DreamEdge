import { useEffect, useRef, useState } from 'react';
import type { CandidateBuild, VersionOperation, WorkspaceProject, WorkspaceStatus } from '../shared/contracts';

export function useCandidateBuild(projectId: string) {
  const [project, setProject] = useState<WorkspaceProject>();
  const [record, setRecord] = useState<CandidateBuild>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const pending = useRef(false);
  async function refresh() {
    const result = await window.dreamEdge.workspace({ operation: 'current' }) as WorkspaceStatus;
    if (alive.current && result.project?.definition.id === projectId) setProject(result.project);
    return result.project;
  }
  useEffect(() => {
    alive.current = true;
    void refresh().catch(error => { if (alive.current) setError(error.message); });
    return () => { alive.current = false; };
  }, [projectId]);
  useEffect(() => {
    if (!record || record.status !== 'running') return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await window.dreamEdge.build({ operation: 'get', projectId, buildId: record.id }) as CandidateBuild;
        if (!cancelled) { setRecord(next); if (next.status === 'running') timer = setTimeout(() => { void poll(); }, 400); }
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : '无法读取构建进度。'); }
    };
    timer = setTimeout(() => { void poll(); }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectId, record?.id, record?.status]);
  async function action(run: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await run(); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '操作失败，请重试。'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  const start = (dependencies: Record<string, string>) => action(async () => {
    const next = await window.dreamEdge.build({ operation: 'start', projectId, dependencies }) as CandidateBuild;
    if (alive.current) { setRecord(next); setSaved(false); }
  });
  const cancel = () => action(async () => {
    if (!record) return;
    const next = await window.dreamEdge.build({ operation: 'cancel', projectId, buildId: record.id }) as CandidateBuild;
    if (alive.current) setRecord(next);
  });
  const preview = () => action(async () => { if (record) await window.dreamEdge.build({ operation: 'openPreview', projectId, buildId: record.id }); });
  const clearCache = () => action(async () => {
    await window.dreamEdge.build({ operation: 'clearDependencyCache', projectId });
    if (alive.current) setNotice('依赖缓存已清理，下次构建将重新下载。');
  });
  const confirm = () => action(async () => {
    if (!record) return;
    let operation = await window.dreamEdge.versions({ operation: 'confirm', projectId, buildId: record.id, label: '保存依赖与候选构建' }) as VersionOperation;
    while (alive.current && operation.status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!alive.current) return;
      operation = await window.dreamEdge.versions({ operation: 'getOperation', projectId, operationId: operation.id }) as VersionOperation;
    }
    if (!alive.current) return;
    if (operation.status !== 'completed') throw new Error(operation.error ?? '保存未完成，请核对工程后重试。');
    await refresh(); if (alive.current) setSaved(true);
  });
  return { project, record, busy, saved, error, notice, start, cancel, preview, confirm, clearCache };
}
