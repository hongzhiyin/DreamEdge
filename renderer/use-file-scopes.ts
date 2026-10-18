import { useEffect, useRef, useState } from 'react';
import type { FileScopeOverview } from '../src/files/scope-types.js';

export function useScopeClock(scope: FileScopeOverview | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      clearTimeout(timer); const current = Date.now(); setNow(current);
      const next = scope?.grants.filter(grant => grant.revokedAt === undefined && (grant.expiresAt ?? 0) > current)
        .reduce((time, grant) => Math.min(time, grant.expiresAt!), Infinity) ?? Infinity;
      if (Number.isFinite(next)) timer = setTimeout(tick, Math.min(2_147_483_647, Math.max(0, next - current + 1)));
    };
    tick(); window.addEventListener('focus', tick);
    return () => { clearTimeout(timer); window.removeEventListener('focus', tick); };
  }, [scope]);
  return now;
}

/** Operations retain their source session even when the native picker outlives a view. */
export function useScopeActions(sessionId: string, refresh: (id: string) => Promise<void>) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const alive = useRef(true); const locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function act(operation: () => Promise<unknown>, cancelMessage = '') {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await operation();
      if (alive.current && result === undefined) setNotice(cancelMessage);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : '目录操作失败。');
    } finally {
      try { await refresh(sessionId); }
      catch { if (alive.current) setError('无法刷新目录状态，请重新选择会话。'); }
      locked.current = false; if (alive.current) setBusy(false);
    }
  }
  return { busy, error, notice, act };
}
