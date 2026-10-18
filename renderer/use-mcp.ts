import { useEffect, useRef, useState } from 'react';
import type { McpControlView } from '../src/mcp/control-types.js';
export function useMcp(sessionId: string, open: boolean) {
  const [view, setView] = useState<McpControlView>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const current = useRef(sessionId), pending = useRef(0), sequence = useRef(0); current.current = sessionId;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function refresh() {
    const id = sessionId, ticket = ++sequence.current;
    try {
      const next = await window.dreamedgeMcp?.request({ type: 'snapshot', sessionId: id });
      if (mounted.current && current.current === id && ticket === sequence.current && next) setView(next);
    } catch { if (mounted.current && current.current === id) setError('连接状态暂不可用，请刷新。'); }
  }
  useEffect(() => { setView(undefined); setError(''); void refresh(); }, [sessionId]);
  useEffect(() => { if (!open) return; void refresh(); const timer = setInterval(() => { if (!pending.current) void refresh(); }, 1500);
    return () => clearInterval(timer); }, [sessionId, open]);
  async function act(type: string, fields: Record<string, unknown> = {}) {
    if ((pending.current > 0 && !['disconnect', 'revoke'].includes(type)) || !window.dreamedgeMcp) return false;
    pending.current++; setBusy(true); setError(''); const id = sessionId, ticket = ++sequence.current;
    try {
      const next = await window.dreamedgeMcp.request({ type, sessionId: id, ...fields });
      if (mounted.current && current.current === id && ticket === sequence.current) setView(next); return true;
    } catch (e) { if (mounted.current && current.current === id) setError(e instanceof Error ? e.message : '连接操作失败。'); return false; }
    finally { pending.current--; if (mounted.current) setBusy(pending.current > 0); }
  }
  return { view, busy, error, act, refresh };
}
