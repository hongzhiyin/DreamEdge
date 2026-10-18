import { ArrowDown, RefreshCw, Sparkles } from 'lucide-react';
import type { ChatAttempt, ChatView } from '../src/chat/types.js';
import { useReadingPosition } from './use-reading-position.js';
import type { ApprovalDecisionCommand } from '../src/runtime/tool-contracts.js';
import { AttemptBody } from './AttemptBody.js';

const labels = { running: '正在回复', cancelling: '正在停止', completed: '已完成',
  cancelled: '已停止', failed: '回复失败', interrupted: '生成已中断' };
function attemptLabel(attempt: ChatAttempt) {
  if (attempt.status !== 'running') return labels[attempt.status];
  const active = attempt.timeline?.find(item => item.kind === 'tool' && ['requested', 'awaiting_approval', 'authorized', 'running'].includes(item.call.status));
  return active?.kind === 'tool' ? { requested: '准备调用工具', awaiting_approval: '等待工具确认', authorized: '批次等待执行', running: '工具执行中' }[
    active.call.status as 'requested' | 'awaiting_approval' | 'authorized' | 'running'] : labels.running;
}

export function Messages({ view, pending, retry, approve }: { view: ChatView; pending: boolean;
  retry(sessionId: string, runId: string, mode?: 'continue' | 'read_tools'): Promise<boolean>;
  approve(command: ApprovalDecisionCommand): Promise<boolean> }) {
  const reading = useReadingPosition(view.sessionId, view);
  const last = view.messages.at(-1)?.attempts.at(-1);
  return <div className="messages-shell">
    <div className="messages-scroll" ref={reading.container} onScroll={reading.remember} data-testid="messages-scroll">
      <div className="messages-content" role="log" aria-live="off" aria-label="对话内容">
        {!view.messages.length && <div className="empty-state"><div className="empty-mark"><Sparkles size={30} strokeWidth={1.5} /></div>
          <p className="eyebrow">DreamEdge</p><h1>从一个问题开始</h1><p>整理想法，追问细节，接着聊下去。</p></div>}
        {view.messages.map(question => <div key={question.messageId} className="turn">
          <article className="user-message" aria-label="你的消息" data-testid="user-message">{question.text}</article>
          {question.attempts.map((attempt, index) => <article className="assistant-message" key={attempt.runId}
            aria-label="AI 回复" data-testid="assistant-message" data-status={attempt.status}>
            <div className="assistant-heading"><Sparkles size={16} strokeWidth={1.8} />
              <span>DreamEdge</span>{index > 0 && <span className="attempt-label">重试 {index}</span>}</div>
            <AttemptBody attempt={attempt} view={view} pending={pending} approve={approve} />
            {!attempt.text && !attempt.timeline?.length && <p className="response-placeholder">{attempt.status === 'running' ? '正在思考…' : labels[attempt.status]}</p>}
            <div className={`attempt-status ${attempt.status}`}><span>{attemptLabel(attempt)}</span>
              {attempt === last && !view.activeRunId && ['failed', 'cancelled'].includes(attempt.status) && !attempt.retryBlocked && <>
                <button className="text-button" onClick={() => { void retry(view.sessionId, attempt.runId, 'continue'); }}
                  disabled={pending || !view.acceptingCommands || view.saving.status === 'failed'}>
                  <RefreshCw size={14} />{attempt.timeline?.length ? '继续回答' : '重试'}</button>
                {attempt.canRetryRead && <button className="text-button" disabled={pending || !view.acceptingCommands || view.saving.status === 'failed'}
                  onClick={() => { void retry(view.sessionId, attempt.runId, 'read_tools'); }}>重新尝试读取</button>}
              </>}</div>
            {attempt.error && <p className="inline-error" role="alert">{attempt.error}</p>}
          </article>)}
        </div>)}
      </div>
    </div>
    {reading.away && view.messages.length > 0 && <button className="jump-latest" onClick={reading.latest}><ArrowDown size={15} />回到最新</button>}
  </div>;
}
