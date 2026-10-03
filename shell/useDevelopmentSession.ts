import { useEffect, useRef, useState } from 'react';
import type { DevelopmentSession, DevelopmentSessionSummary } from '../shared/contracts';

export function useDevelopmentSession(projectId: string) {
  const [sessions, setSessions] = useState<DevelopmentSessionSummary[]>([]);
  const [session, setSession] = useState<DevelopmentSession>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const alive = useRef(true); const pending = useRef(false); const generation = useRef(0);
  async function list() {
    const value = await window.dreamEdge.development({ operation: 'listSummaries', projectId }) as DevelopmentSessionSummary[];
    if (alive.current) setSessions(value.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    return value;
  }
  useEffect(() => {
    alive.current = true; const current = ++generation.current;
    void (async () => {
      try {
        const history = await list();
        if (!alive.current || generation.current !== current) return;
        const latest = history.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (latest) {
          const value = await window.dreamEdge.development({ operation: 'get', projectId, sessionId: latest.id }) as DevelopmentSession;
          if (alive.current && generation.current === current) setSession(value);
        }
      } catch (error) { if (alive.current && generation.current === current) setError(error instanceof Error ? error.message : '无法读取会话。'); }
    })();
    return () => { alive.current = false; generation.current++; };
  }, [projectId]);
  const running = session?.turns.at(-1)?.status === 'running';
  useEffect(() => {
    if (!session || !running) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await window.dreamEdge.development({ operation: 'get', projectId, sessionId: session.id }) as DevelopmentSession;
        if (cancelled) return;
        setSession(value);
        if (value.turns.at(-1)?.status === 'running') timer = setTimeout(() => { void poll(); }, 400); else await list();
      } catch (error) { if (!cancelled) setError(error instanceof Error ? error.message : '无法读取模型回复。'); }
    };
    timer = setTimeout(() => { void poll(); }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectId, session?.id, running]);
  async function action(run: (epoch: number) => Promise<void>) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError(''); const epoch = ++generation.current;
    try { await run(epoch); return alive.current && generation.current === epoch; }
    catch (error) { if (alive.current && generation.current === epoch) setError(error instanceof Error ? error.message : '会话操作失败。'); return false; }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  const select = (sessionId: string) => action(async epoch => {
    const value = await window.dreamEdge.development({ operation: 'get', projectId, sessionId }) as DevelopmentSession;
    if (alive.current && generation.current === epoch) setSession(value);
  });
  const create = () => action(async epoch => {
    const value = await window.dreamEdge.development({ operation: 'create', projectId, title: '新会话' }) as DevelopmentSession;
    if (alive.current && generation.current === epoch) { setSession(value); await list(); }
  });
  const send = (prompt: string, commit = false) => action(async epoch => {
    let target = session;
    if (!target) target = await window.dreamEdge.development({ operation: 'create', projectId, title: '新会话' }) as DevelopmentSession;
    if (!alive.current || generation.current !== epoch) return;
    const value = await window.dreamEdge.development({ operation: 'send', projectId, sessionId: target.id, prompt, commit }) as DevelopmentSession;
    if (alive.current && generation.current === epoch) { setSession(value); await list(); }
  });
  const cancel = () => action(async epoch => {
    if (!session) return;
    const value = await window.dreamEdge.development({ operation: 'cancel', projectId, sessionId: session.id }) as DevelopmentSession;
    if (alive.current && generation.current === epoch) { setSession(value); await list(); }
  });
  return { sessions, session, running, busy, error, select, create, send, cancel };
}
