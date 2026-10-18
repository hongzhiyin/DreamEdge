import { useCallback, useEffect, useRef, useState } from 'react';
import { newerFrame } from '../src/chat/replica.js';
import type { ChatConnection, ChatEvent, ChatSession, ChatView } from '../src/chat/types.js';
import type { ThinkingLevel } from '../src/model/types.js';
import type { ApprovalDecisionCommand } from '../src/runtime/tool-contracts.js';

const bridge = window.dreamedge;
export function useChat() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [connection, setConnection] = useState<ChatConnection>();
  const [selectedId, setSelectedId] = useState('');
  const [view, setView] = useState<ChatView>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const selected = useRef('');
  const frames = useRef(new Map<string, ChatEvent>());
  const tickets = useRef(new Map<string, number>());
  const apply = useCallback((event: ChatEvent, resetEpoch = false) => {
    if (!newerFrame(frames.current.get(event.sessionId), event, resetEpoch)) return;
    frames.current.set(event.sessionId, event);
    setSessions(previous => {
      const summary = { sessionId: event.sessionId, title: event.view.title, updatedAt: event.view.updatedAt };
      return previous.some(session => session.sessionId === event.sessionId)
        ? previous.map(session => session.sessionId === event.sessionId ? summary : session) : [summary, ...previous];
    });
    if (selected.current === event.sessionId) setView(event.view);
  }, []);
  const sync = useCallback(async (id: string) => {
    const ticket = (tickets.current.get(id) ?? 0) + 1;
    tickets.current.set(id, ticket);
    const last = frames.current.get(id);
    const reply = await bridge.watch(id, last ? { epoch: last.epoch, sequence: last.sequence } : undefined);
    if (tickets.current.get(id) !== ticket) return;
    if (reply.kind === 'snapshot') apply(reply.event, true);
    else for (const event of reply.events) apply(event);
  }, [apply]);
  const select = useCallback((id: string) => {
    selected.current = id; setSelectedId(id); setError('');
    setView(frames.current.get(id)?.view);
    try { sessionStorage.setItem('dreamedge:selected', id); } catch { /* Optional UI state. */ }
    void sync(id).catch(() => { if (selected.current === id) setError('无法读取会话，请重新选择。'); });
  }, [sync]);
  useEffect(() => {
    let alive = true;
    const unsubscribe = bridge.subscribe(event => { if (alive) apply(event); });
    const restore = () => {
      if (selected.current) void sync(selected.current).catch(() => setError('恢复对话失败，请重新选择会话。'));
    };
    const visible = bridge.onVisible(restore);
    const visibility = () => { if (document.visibilityState === 'visible') restore(); };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', restore);
    void bridge.initialize().then(async initial => {
      if (!alive) return;
      setConnection(initial.connection);
      const items = initial.sessions.length ? initial.sessions : [await bridge.createSession()];
      if (!alive) return;
      setSessions(items);
      let stored = '';
      try { stored = sessionStorage.getItem('dreamedge:selected') ?? ''; } catch { /* Optional UI state. */ }
      select(items.find(item => item.sessionId === stored)?.sessionId ?? items[0]!.sessionId);
    }).catch(() => { if (alive) setError('无法连接聊天服务，请重新启动 DreamEdge。'); });
    return () => {
      alive = false; unsubscribe(); visible();
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', restore);
    };
  }, [apply, select, sync]);

  async function act(operation: () => Promise<unknown>, id = selected.current): Promise<boolean> {
    setError(''); setPending(true);
    try { await operation(); await sync(id); return true; }
    catch (failure) {
      if (selected.current === id) setError(failure instanceof Error ? failure.message : '操作失败，请重试。');
      return false;
    }
    finally { setPending(false); }
  }
  async function create(): Promise<void> {
    setPending(true); setError('');
    try {
      const session = await bridge.createSession();
      setSessions(previous => [session, ...previous]); select(session.sessionId);
    } catch { setError('无法新建对话，请重试。'); }
    finally { setPending(false); }
  }
  return { sessions, connection, selectedId, view, error, pending, select, create,
    refresh: sync,
    send: (text: string, thinkingLevel: ThinkingLevel) => {
      const id = selected.current;
      return act(() => bridge.send({ sessionId: id, clientMessageId: crypto.randomUUID(), text, thinkingLevel }), id);
    },
    stop: (sessionId: string, runId: string) => act(() => bridge.stop(sessionId, runId), sessionId),
    retry: (sessionId: string, runId: string, mode?: 'continue' | 'read_tools') => act(() => bridge.retry(sessionId, runId, mode), sessionId),
    approve: (decision: ApprovalDecisionCommand) => act(() => {
      if (!bridge.decideApproval) throw new Error('当前应用不支持工具确认，请更新应用。');
      return bridge.decideApproval(decision);
    }, decision.sessionId),
    retrySave: () => act(() => bridge.retrySave(selected.current)),
  };
}
