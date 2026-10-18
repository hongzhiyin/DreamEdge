import { useLayoutEffect, useRef } from 'react';
import { ArrowUp, Check, Square } from 'lucide-react';
import type { ChatConnection, ChatView } from '../src/chat/types.js';
import type { ThinkingLevel } from '../src/model/types.js';
import { isSubmitKey } from '../src/chat/input.js';

const thoughtLabels = { off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高' };
export function Composer({ view, connection, draft, change, level, setLevel, pending, send, stop, retrySave }: {
  view: ChatView; connection: ChatConnection; draft: string; change(text: string): void;
  level: ThinkingLevel; setLevel(value: ThinkingLevel): void; pending: boolean;
  send(): Promise<void>; stop(sessionId: string, runId: string): Promise<boolean>; retrySave(): Promise<boolean>;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const endedAt = useRef(-Infinity);
  const generating = Boolean(view.activeRunId);
  const failedSave = view.saving.status === 'failed';
  useLayoutEffect(() => {
    if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(input.current.scrollHeight, 180)}px`; }
  }, [draft]);
  useLayoutEffect(() => { input.current?.focus(); }, [view.sessionId]);
  const allowed = view.acceptingCommands && !pending && !generating && !failedSave && Boolean(draft.trim());
  return <footer className="composer-area">
    {failedSave && <div className="save-error" role="alert"><span>{view.saving.error}</span>
      <button onClick={() => { void retrySave(); }} disabled={pending}>重试保存</button></div>}
    <div className="composer-box">
      <label className="sr-only" htmlFor="chat-input">消息</label>
      <textarea ref={input} id="chat-input" rows={2} placeholder="写下你的问题…" value={draft} disabled={pending}
        onChange={event => change(event.target.value)} maxLength={100_000}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; endedAt.current = performance.now(); }}
        onKeyDown={event => {
          if (!isSubmitKey({ key: event.key, shiftKey: event.shiftKey,
            isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, composing.current, endedAt.current, performance.now())) return;
          event.preventDefault(); if (allowed) void send();
        }} />
      <div className="composer-controls"><span className="model-label">{connection.model}</span>
        <label className="thinking-label">思考<select aria-label="思考强度" value={level}
          onChange={event => setLevel(event.target.value as ThinkingLevel)}>
          {connection.levels.map(value => <option key={value} value={value}>{thoughtLabels[value]}</option>)}
        </select></label>
        {generating ? <button className="send-button stop" aria-label="停止生成" disabled={pending || view.messages.at(-1)?.attempts.at(-1)?.status === 'cancelling'}
          onClick={() => { void stop(view.sessionId, view.activeRunId!); }}><Square size={16} fill="currentColor" /></button>
          : <button className="send-button" aria-label="发送消息" disabled={!allowed} onClick={() => { void send(); }}><ArrowUp size={21} /></button>}
      </div>
    </div>
    <div className="composer-hint"><span>Enter 发送 · Shift + Enter 换行</span>
      <span className="save-status" aria-live="polite">{view.saving.status === 'saved' ? <><Check size={12} />已保存</>
        : view.saving.status === 'pending' ? '正在保存' : view.saving.status === 'failed' ? '保存失败' : '临时会话'}</span></div>
  </footer>;
}
