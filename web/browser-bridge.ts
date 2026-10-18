import type { ChatBridge, ChatEvent } from '../src/chat/types.js';

/** Serialized into the web page before the unchanged renderer module is evaluated. */
function installBridge() {
  const events = new Set<(event: ChatEvent) => void>(), visible = new Set<() => void>();
  const clientId = crypto.randomUUID();
  const embedded = location.pathname === '/embedded';
  let handoff = '';
  const headers = () => ({ 'x-dreamedge-csrf': csrf, ...(embedded ? { 'x-dreamedge-handoff': handoff } : {}) });
  let csrf = '', stream: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const unpair = () => { if (embedded) { document.body.textContent = '会话连接已失效，请从业务应用重新打开外部对话。'; return; } localStorage.removeItem('dreamedge:web-csrf'); location.replace('/pair'); };
  const ready = (async () => {
    if (embedded) {
      const ticket = location.hash.slice(1); history.replaceState(null, '', '/embedded');
      if (ticket) {
        const response = await fetch('/api/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }) });
        const result = await response.json();
        if (!response.ok) { unpair(); throw new Error('会话入口已过期。'); }
        sessionStorage.setItem('ai-session:token', result.token);
      }
      handoff = sessionStorage.getItem('ai-session:token') ?? ''; csrf = handoff;
    } else csrf = localStorage.getItem('dreamedge:web-csrf') ?? '';
    if (!csrf) { unpair(); throw new Error('请重新配对本机 DreamEdge。'); }
    const response = await fetch('/api/session', { headers: headers() });
    if (!response.ok) { unpair(); throw new Error('网页连接已失效，请重新配对。'); }
  })();
  async function request(channel: string, command: unknown) {
    await ready;
    const response = await fetch(channel === 'chat' ? '/api/chat' : '/api/extension/' + encodeURIComponent(channel), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...headers() },
      body: JSON.stringify({ clientId, command }),
    });
    if (response.status === 401 || response.status === 403) { unpair(); throw new Error('网页连接已失效。'); }
    const reply = await response.json();
    if (!reply.ok) throw new Error(reply.error?.message || '操作失败，请重试。');
    return reply.data;
  }
  async function connect() {
    if (stream || !events.size) return;
    const controller = new AbortController(); stream = controller;
    try {
      const response = await fetch('/api/events?clientId=' + clientId, {
        headers: headers(), signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) { unpair(); return; }
      if (!response.ok || !response.body) throw new Error('Stream unavailable');
      for (const fn of visible) fn();
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (!controller.signal.aborted) {
        const result = await reader.read(); if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (block.startsWith('event: auth')) { unpair(); controller.abort(); return; }
          const data = block.split('\n').find(line => line.startsWith('data: '));
          if (data) {
            const event = JSON.parse(data.slice(6)) as ChatEvent;
            for (const fn of events) fn(event);
          }
        }
      }
    } catch { /* A new connection asks the existing hub to replay or provide a snapshot. */ }
    finally {
      if (stream === controller) {
        stream = undefined;
        if (events.size && !controller.signal.aborted) timer = setTimeout(() => { void connect(); }, 1000);
      }
    }
  }
  function subscribe(listener: (event: ChatEvent) => void) {
    events.add(listener); void ready.then(connect).catch(() => {});
    return () => {
      events.delete(listener);
      if (!events.size) { clearTimeout(timer); stream?.abort(); stream = undefined; }
    };
  }
  const bridge: ChatBridge = {
    initialize: () => request('chat', { type: 'initialize' }),
    createSession: () => request('chat', { type: 'create' }),
    watch: (sessionId, cursor) => request('chat', { type: 'watch', sessionId, ...(cursor ? { cursor } : {}) }),
    send: input => request('chat', { type: 'send', input }),
    stop: (sessionId, runId) => request('chat', { type: 'stop', sessionId, runId }),
    retry: (sessionId, runId, mode) => request('chat', { type: 'retry', sessionId, runId, ...(mode ? { mode } : {}) }),
    retrySave: sessionId => request('chat', { type: 'retrySave', sessionId }),
    decideApproval: decision => request('chat', { type: 'approval', decision }),
    resumeBatch: reference => request('chat', { type: 'resumeBatch', reference }),
    subscribe,
    onVisible: listener => { visible.add(listener); return () => { visible.delete(listener); }; },
  };
  Object.defineProperty(window, 'dreamedge', { value: Object.freeze(bridge), configurable: false, writable: false });
  Object.defineProperty(window, 'dreamedgeEmbedded', { value: embedded });
  if (!embedded) Object.defineProperty(window, 'dreamedgeMcp', { value: Object.freeze({ request: (command: unknown) => request('mcp', command) }), configurable: false, writable: false });
  Object.defineProperty(window, 'dreamedgeWeb', { value: Object.freeze({ request }), configurable: false, writable: false });
}
export const browserBridgeSource = `(${installBridge.toString()})();`;
