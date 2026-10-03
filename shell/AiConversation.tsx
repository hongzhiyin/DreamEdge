import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, MessageSquarePlus, Sparkles, Square } from 'lucide-react';
import { useDevelopmentSession } from './useDevelopmentSession';
import { ChatTurn } from './ChatTurn';

export function AiConversation({ projectId, configured, active, commit, modelName, openSettings }: {
  projectId: string; configured: boolean; active: boolean; commit: boolean; modelName?: string; openSettings: () => void;
}) {
  const chat = useDevelopmentSession(projectId); const [prompt, setPrompt] = useState('');
  const [expanded, setExpanded] = useState<string>(); const [atBottom, setAtBottom] = useState(true);
  const thread = useRef<HTMLDivElement>(null); const input = useRef<HTMLTextAreaElement>(null);
  const viewportHeight = useRef(0); const pinned = useRef(true); const position = useRef(0); const locked = chat.busy || chat.running;
  useEffect(() => { setExpanded(undefined); pinned.current = true; setAtBottom(true); }, [chat.session?.id]);
  useLayoutEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (thread.current) thread.current.scrollTop = pinned.current ? thread.current.scrollHeight : position.current;
    });
    return () => cancelAnimationFrame(frame);
  }, [chat.session, active]);
  useEffect(() => {
    if (!active || !thread.current) return;
    const observer = new ResizeObserver(() => {
      if (!thread.current) return;
      viewportHeight.current = thread.current.clientHeight;
      if (pinned.current) thread.current.scrollTop = thread.current.scrollHeight;
    });
    observer.observe(thread.current);
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    if (!active || !input.current) return;
    const follow = pinned.current;
    input.current.style.height = 'auto'; input.current.style.height = Math.min(144, Math.max(64, input.current.scrollHeight)) + 'px';
    if (follow && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [prompt, active]);
  async function send() {
    if (locked || !configured || !prompt.trim()) return;
    pinned.current = true; setAtBottom(true);
    if (await chat.send(prompt, commit)) { setPrompt(''); input.current?.focus(); }
  }
  return <section className="ai-conversation" aria-label="AI 会话">
    <div className="conversation-toolbar">
      <label className="session-picker"><span className="sr-only">会话记录</span><select aria-label="会话记录" value={chat.session?.id ?? ''} disabled={locked}
        onChange={event => { void chat.select(event.target.value); }}>
        {!chat.session && <option value="">新会话</option>}
        {chat.sessions.map(session => <option key={session.id} value={session.id}>{session.title} · {session.turnCount} 轮</option>)}
      </select></label>
      <button className="icon-button" aria-label="新会话" title="新会话" disabled={locked} onClick={() => { void chat.create(); }}><MessageSquarePlus size={18} strokeWidth={1.75} aria-hidden="true" /></button>
    </div>
    <div className="conversation-content">
      <div ref={thread} className="chat-thread" role="log" aria-label="会话内容" aria-live="polite" onScroll={event => {
        const element = event.currentTarget;
        // Resizing the composer/window is not the user's decision to leave the bottom.
        if (pinned.current && viewportHeight.current && viewportHeight.current !== element.clientHeight) return;
        position.current = element.scrollTop;
        pinned.current = element.scrollHeight - element.clientHeight - element.scrollTop < 48; setAtBottom(pinned.current);
      }}>
        {!chat.session?.turns.length && <div className="chat-empty">
          <Sparkles size={28} strokeWidth={1.5} aria-hidden="true" /><h2>你想怎样修改这个工程？</h2>
          <p>描述想要的效果，AI 会自动修改、构建并刷新应用。</p>
          <button className="chat-suggestion" onClick={() => { setPrompt('先查看工程，把问候语改成 Hello DreamEdge'); input.current?.focus(); }}>修改页面问候语</button>
        </div>}
        {chat.session?.turns.map((turn, index) => <ChatTurn key={turn.id} turn={turn} index={index} projectId={projectId} sessionId={chat.session!.id}
          expanded={expanded === turn.id} expand={() => setExpanded(expanded === turn.id ? undefined : turn.id)} locked={locked} />)}
        {chat.error && <p role="alert" className="sidebar-error">{chat.error}</p>}
      </div>
      {!atBottom && <button className="chat-latest" aria-label="回到最新消息" onClick={() => {
        pinned.current = true; setAtBottom(true); thread.current?.scrollTo({ top: thread.current.scrollHeight });
      }}><ArrowDown size={15} aria-hidden="true" />最新消息</button>}
    </div>
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      {!configured && <button type="button" className="chat-connect" onClick={openSettings}>配置模型连接，开始对话 <span aria-hidden="true">→</span></button>}
      <div className="composer-box">
        <label className="sr-only" htmlFor="chat-request">修改需求</label>
        <textarea ref={input} id="chat-request" aria-label="修改需求" value={prompt} onChange={event => setPrompt(event.target.value)}
          placeholder="描述你希望做的修改…" rows={2} maxLength={8192} required disabled={locked}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault(); void send();
            }
          }} />
        <div className="composer-actions"><span className="composer-model">{configured ? modelName : '未连接模型'}{commit && configured ? ' · 自动提交 Git' : ''}</span>
          {chat.running ? <button className="composer-send" type="button" aria-label="取消请求" title="取消请求" disabled={chat.busy} onClick={() => { void chat.cancel(); }}><Square size={14} aria-hidden="true" /></button>
            : <button className="composer-send" type="submit" aria-label="发送给 AI" title="发送给 AI" disabled={locked || !configured || !prompt.trim()}><ArrowUp size={18} aria-hidden="true" /></button>}
        </div>
      </div>
      <p className="composer-hint">Enter 发送 · Shift + Enter 换行<span>自动应用修改</span></p>
    </form>
  </section>;
}
