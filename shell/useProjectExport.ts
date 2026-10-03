import { useEffect, useRef, useState } from 'react';
import type { ExportMode, ExportRequest, ExportStatus, ProjectExport } from '../shared/contracts';

export function useProjectExport(projectId: string) {
  const [status, setStatus] = useState<ExportStatus>(); const [record, setRecord] = useState<ProjectExport>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const alive = useRef(true); const pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    void window.dreamEdge.exportApp({ operation: 'current', projectId }).then(value => { if (alive.current) { setStatus(value as ExportStatus); setRecord((value as ExportStatus).record ?? undefined); } }).catch(error => { if (alive.current) setError(error.message); });
    return () => { alive.current = false; };
  }, [projectId]);
  useEffect(() => {
    if (record?.status !== 'running') return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await window.dreamEdge.exportApp({ operation: 'get', projectId, exportId: record.id }) as ProjectExport;
        if (cancelled) return; setRecord(value);
        if (value.status === 'running') timer = setTimeout(() => { void poll(); }, 500);
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : '读取导出进度失败。'); }
    };
    timer = setTimeout(() => { void poll(); }, 500); return () => { cancelled = true; clearTimeout(timer); };
  }, [projectId, record?.id, record?.status]);
  async function run(operation: 'start' | 'cancel' | 'reveal', mode: ExportMode = 'standard') {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const request: ExportRequest = operation === 'start' ? { operation, projectId, mode } : { operation, projectId, exportId: record!.id };
      const result = await window.dreamEdge.exportApp(request);
      if (alive.current && result && 'status' in result) setRecord(result as ProjectExport);
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '导出操作失败。'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return { supported: status?.supported, arch: status?.arch, record, running: record?.status === 'running', busy, error, run };
}
