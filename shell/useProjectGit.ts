import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitRequest, GitStatus } from '../shared/contracts';

type Operation = 'commit' | 'discard' | 'restore' | 'fetch' | 'pull' | 'push';
const notices = { commit: '工程修改已提交 Git。', discard: '未提交的工程修改已撤销，页面已刷新。', restore: '已恢复提交内容，可检查后再提交。',
  fetch: '远程状态已更新。', pull: '远程内容已拉取，页面正在自动更新。', push: '本地提交已推送。' };
export function useProjectGit(projectId: string) {
  const [status, setStatus] = useState<GitStatus>(); const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [readError, setReadError] = useState('');
  const alive = useRef(true); const pending = useRef(false); const reading = useRef(false);
  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try { const value = await window.dreamEdge.git({ operation: 'status', projectId }) as GitStatus; if (alive.current) { setStatus(value); setReadError(''); } }
    catch (error) { if (alive.current) setReadError(error instanceof Error ? error.message : '无法读取 Git 状态。'); }
    finally { reading.current = false; }
  }, [projectId]);
  useEffect(() => {
    alive.current = true; void load();
    const reload = () => { if (!pending.current) void load(); };
    const stop = window.dreamEdge.onContextChanged(reload); const timer = setInterval(reload, 3000);
    window.addEventListener('focus', reload);
    return () => { alive.current = false; stop(); clearInterval(timer); window.removeEventListener('focus', reload); };
  }, [load]);
  async function run(operation: Operation, options?: { message?: string; commitId?: string }) {
    if (pending.current || !status) return;
    pending.current = true; setBusy(operation); setError(''); setNotice(''); let failure = '';
    try {
      await window.dreamEdge.git({ operation, projectId, expectedStateHash: status.stateHash,
        message: options?.message ?? `更新工程（${status.changed.length} 项修改）`, commitId: options?.commitId } as GitRequest);
      if (alive.current) setNotice(notices[operation]);
    } catch (error) { failure = error instanceof Error ? error.message : 'Git 操作失败。'; }
    finally { await load(); pending.current = false; if (alive.current) { setBusy(null); if (failure) setError(failure); } }
  }
  return { status, busy, error: error || readError, notice, load, run };
}
export type ProjectGit = ReturnType<typeof useProjectGit>;
