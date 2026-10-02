import { useEffect, useRef, useState } from 'react';
import { useDevelopmentSession } from './useDevelopmentSession';
import { CandidateCard } from './CandidateCard';

export function AiConversation({ projectId, configured }: { projectId: string; configured: boolean }) {
  const chat = useDevelopmentSession(projectId); const [prompt, setPrompt] = useState('');
  const [turnId, setTurnId] = useState<string>(); const [candidateBusy, setCandidateBusy] = useState(false);
  const reply = useRef<HTMLDivElement>(null);
  const locked = chat.busy || chat.running || candidateBusy;
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
    <details className="ai-context"><summary>源码上下文 · 已选 {chat.paths.length} 个文件</summary>
      <p className="ai-hint">将所选源码及会话上下文发送给配置的模型服务，最多 20 个文件、128 KB。</p>
      <div className="ai-context-files">{chat.files.map(path => <label className="ai-checkbox" key={path}><input type="checkbox" checked={chat.paths.includes(path)}
        disabled={locked || !chat.paths.includes(path) && chat.paths.length >= 20} onChange={event => chat.setPaths(event.target.checked ? [...chat.paths, path] : chat.paths.filter(item => item !== path))} />{path}</label>)}</div>
    </details>
    <form className="ai-form ai-composer" onSubmit={event => { event.preventDefault(); void chat.send(prompt).then(sent => { if (sent) setPrompt(''); }); }}>
      <label>修改需求<textarea value={prompt} onChange={event => setPrompt(event.target.value)} disabled={locked}
        placeholder="例如：将 HelloWorld 改为 Hello DreamEdge" rows={3} maxLength={8192} required /></label>
      {!configured && <p className="ai-hint">请先配置上方的模型连接。</p>}
      <div className="ai-buttons"><button className="ai-button primary" type="submit" disabled={locked || !configured || !prompt.trim() || !chat.paths.length}>发送给 AI</button>
        {chat.running && <button className="ai-button" type="button" disabled={chat.busy} onClick={() => { void chat.cancel(); }}>取消请求</button>}
      </div>
    </form>
    {chat.running && <p role="status">AI 正在生成回复与候选修改…</p>}
    {chat.busy && !chat.running && <p role="status">正在处理会话…</p>}
    {chat.error && <p role="alert" className="sidebar-error">{chat.error}</p>}
    {!chat.session?.turns.length && <p className="ai-hint">描述你希望做的修改，收到候选后先预览，再确认保存。</p>}
    <div ref={reply} className="ai-turns" aria-label="会话内容" aria-live="polite">
      {chat.session?.turns.map((turn, index) => <article className="ai-turn" key={turn.id}>
        <p className="ai-turn-label">你 · 第 {index + 1} 轮</p><p className="ai-message">{turn.prompt}</p>
        {turn.summary && <><p className="ai-turn-label">AI</p><p className="ai-message">{turn.summary}</p></>}
        {turn.error && <p role="alert" className="sidebar-error">{turn.error}</p>}
        {turn.status === 'completed' && turn.changes.length > 0 && <button className="ai-button" disabled={locked}
          onClick={() => setTurnId(turn.id)}>查看第 {index + 1} 轮修改 · {turn.changes.length} 个文件</button>}
        {turn.status === 'completed' && !turn.changes.length && <p className="ai-hint">本次回复没有文件修改。</p>}
      </article>)}
    </div>
    {turnId && chat.session && <CandidateCard key={`${chat.session.id}/${turnId}`} projectId={projectId}
      reference={{ sessionId: chat.session.id, turnId }} busyChanged={setCandidateBusy} />}
  </section>;
}
