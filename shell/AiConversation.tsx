import { useEffect, useRef, useState } from 'react';
import { useDevelopmentSession } from './useDevelopmentSession';
import { CandidateCard } from './CandidateCard';

export function AiConversation({ projectId, configured }: { projectId: string; configured: boolean }) {
  const chat = useDevelopmentSession(projectId); const [prompt, setPrompt] = useState('');
  const [turnId, setTurnId] = useState<string>(); const [commit, setCommit] = useState(false);
  const reply = useRef<HTMLDivElement>(null);
  const locked = chat.busy || chat.running;
  const latest = chat.session?.turns.at(-1);
  useEffect(() => {
    if (latest?.status === 'completed' && latest.changes.length) setTurnId(latest.id);
    else setTurnId(undefined);
  }, [chat.session?.id, latest?.id, latest?.status]);
  useEffect(() => { if (latest && latest.status !== 'running') reply.current?.scrollIntoView({ block: 'nearest' }); }, [latest?.id, latest?.status]);
  return <section className="ai-conversation" aria-label="AI 会话">
    <header className="ai-heading"><h2>AI 会话</h2><button className="ai-button" disabled={locked} onClick={() => { void chat.create(); }}>新会话</button></header>
    {chat.sessions.length > 0 && <label className="ai-session-label">会话记录<select aria-label="会话记录" value={chat.session?.id ?? ''} disabled={locked}
      onChange={event => { setTurnId(undefined); void chat.select(event.target.value); }}>
      {!chat.session && <option value="">选择会话</option>}
      {chat.sessions.map(session => <option key={session.id} value={session.id}>{session.title} · {session.turnCount} 轮</option>)}
    </select></label>}
    <p className="ai-hint">AI 会自动查阅源码、构建并应用修改，完成后页面自动刷新。读取内容及会话上下文会发送给配置的模型服务。</p>
    <form className="ai-form ai-composer" onSubmit={event => { event.preventDefault(); void chat.send(prompt, commit).then(sent => { if (sent) setPrompt(''); }); }}>
      <label>修改需求<textarea value={prompt} onChange={event => setPrompt(event.target.value)} disabled={locked}
        placeholder="例如：将 HelloWorld 改为 Hello DreamEdge" rows={3} maxLength={8192} required /></label>
      <label className="ai-checkbox"><input type="checkbox" checked={commit} disabled={locked} onChange={event => setCommit(event.target.checked)} />本轮完成后提交工程修改到 Git</label>
      {!configured && <p className="ai-hint">请先配置上方的模型连接。</p>}
      <div className="ai-buttons"><button className="ai-button primary" type="submit" disabled={locked || !configured || !prompt.trim()}>发送给 AI</button>
        {chat.running && <button className="ai-button" type="button" disabled={chat.busy} onClick={() => { void chat.cancel(); }}>取消请求</button>}
      </div>
    </form>
    {chat.running && <p role="status">{latest?.phase === 'building' ? '正在自动构建修改…' : latest?.phase === 'applying' ? '正在应用修改并刷新页面…' : 'AI 正在查看工程并生成修改…'}</p>}
    {chat.busy && !chat.running && <p role="status">正在处理会话…</p>}
    {chat.error && <p role="alert" className="sidebar-error">{chat.error}</p>}
    {!chat.session?.turns.length && <p className="ai-hint">直接描述你希望做的修改，框架会自动完成构建和保存。</p>}
    <div ref={reply} className="ai-turns" aria-label="会话内容" aria-live="polite">
      {chat.session?.turns.map((turn, index) => <article className="ai-turn" key={turn.id}>
        <p className="ai-turn-label">你 · 第 {index + 1} 轮</p><p className="ai-message">{turn.prompt}</p>
        {!!turn.activity?.length && <details className="ai-context" open={turn.status === 'running'}>
          <summary>工程查阅 · {turn.activity.length} 次操作</summary>
          <ul>{turn.activity.map(event => <li key={event.id}>
            {{ list_files: '查看目录', read_file: '读取文件', search_files: '搜索源码' }[event.tool]} · {event.detail} ·
            {{ running: '进行中', completed: '完成', failed: '失败', cancelled: '已停止' }[event.status]}
          </li>)}</ul>
        </details>}
        {turn.summary && <><p className="ai-turn-label">AI</p><p className="ai-message">{turn.summary}</p></>}
        {turn.applied && <p className="ai-hint">修改已应用，页面已自动刷新。</p>}
        {turn.commitId && <p className="ai-hint">已提交 Git：{turn.commitId.slice(0, 8)}</p>}
        {turn.warning && <p role="status" className="ai-hint">{turn.warning}</p>}
        {turn.error && <p role="alert" className="sidebar-error">{turn.error}</p>}
        {turn.status === 'completed' && turn.changes.length > 0 && <button className="ai-button" disabled={locked}
          onClick={() => setTurnId(turn.id)}>查看第 {index + 1} 轮修改 · {turn.changes.length} 个文件</button>}
        {turn.status === 'completed' && !turn.changes.length && <p className="ai-hint">本次回复没有文件修改。</p>}
      </article>)}
    </div>
    {turnId && chat.session && <CandidateCard key={`${chat.session.id}/${turnId}`} projectId={projectId}
      reference={{ sessionId: chat.session.id, turnId }} />}
  </section>;
}
