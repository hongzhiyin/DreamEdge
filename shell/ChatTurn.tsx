import { Bot, Check, ChevronDown } from 'lucide-react';
import type { DevelopmentTurn } from '../shared/contracts';
import { CandidateCard } from './CandidateCard';

export function ChatTurn({ turn, index, projectId, sessionId, expanded, expand, locked }: {
  turn: DevelopmentTurn; index: number; projectId: string; sessionId: string; expanded: boolean; expand: () => void; locked: boolean;
}) {
  return <article className="chat-turn">
    <div className="chat-message user-message"><span className="sr-only">你 · 第 {index + 1} 轮</span><p>{turn.prompt}</p></div>
    <div className="chat-message assistant-message">
      <div className="assistant-identity"><Bot size={17} strokeWidth={1.75} aria-hidden="true" /><span>DreamEdge</span></div>
      {turn.summary && <p className="chat-reply">{turn.summary}</p>}
      {!!turn.activity?.length && <details className="ai-context chat-activity">
        <summary>{turn.activity.some(event => event.tool === 'resolve_dependency' || event.tool === 'set_dependencies') ? '工程操作' : '工程查阅'} · {turn.activity.length} 次操作</summary>
        <ul>{turn.activity.map(event => <li key={event.id}>
          {{ list_files: '查看目录', read_file: '读取文件', search_files: '搜索源码', resolve_dependency: '查询依赖', set_dependencies: '声明依赖' }[event.tool]} · {event.detail} ·
          {{ running: '进行中', completed: '完成', failed: '失败', cancelled: '已停止' }[event.status]}
        </li>)}</ul>
      </details>}
      {turn.applied && <p className="chat-result"><Check size={14} aria-hidden="true" />修改已应用，页面已自动刷新。</p>}
      {turn.commitId && <p className="ai-hint">已提交 Git：{turn.commitId.slice(0, 8)}</p>}
      {turn.warning && <p role="status" className="ai-hint">{turn.warning}</p>}
      {turn.error && <p role="alert" className="sidebar-error">{turn.error}</p>}
      {turn.status === 'running' && <p role="status" className="chat-progress">
        <span className="progress-dot" />{turn.phase === 'building' ? '正在自动构建修改…' : turn.phase === 'applying' ? '正在应用修改并刷新页面…' : '正在查看工程并生成修改…'}
      </p>}
      {turn.status === 'completed' && (turn.changes.length > 0 || turn.dependencies !== undefined) && <button className="chat-change-button" disabled={locked}
        aria-expanded={expanded} onClick={expand}>查看第 {index + 1} 轮修改 · {turn.changes.length} 个文件{turn.dependencies !== undefined ? ' · 依赖变更' : ''}<ChevronDown size={15} aria-hidden="true" /></button>}
      {turn.status === 'completed' && !turn.changes.length && turn.dependencies === undefined && <p className="ai-hint">本次回复没有文件修改。</p>}
      {expanded && <CandidateCard projectId={projectId} reference={{ sessionId, turnId: turn.id }} />}
    </div>
  </article>;
}
