import { MessageSquare, Plus, Sparkles } from 'lucide-react';
import type { ChatSession } from '../src/chat/types.js';

export function Sidebar({ sessions, selected, pending, choose, create }: {
  sessions: ChatSession[]; selected: string; pending: boolean; choose(id: string): void; create(): Promise<void>;
}) {
  return <aside className="sidebar" aria-label="会话列表">
    <div className="brand"><Sparkles size={22} strokeWidth={1.8} /><strong>DreamEdge</strong></div>
    <button className="new-chat" disabled={pending} onClick={() => { void create(); }}>
      <Plus size={18} strokeWidth={1.8} />新对话<span>⌘ N</span>
    </button>
    <div className="sidebar-caption">最近对话</div>
    <nav className="session-list" aria-label="历史对话">{sessions.map(session =>
      <button key={session.sessionId} className={`session-item ${selected === session.sessionId ? 'selected' : ''}`}
        aria-current={selected === session.sessionId ? 'page' : undefined} onClick={() => choose(session.sessionId)}
        title={session.title} data-testid="session-item">
        <MessageSquare size={16} strokeWidth={1.8} /><span>{session.title}</span>
      </button>)}
    </nav>
    <div className="sidebar-footer"><span className="connection-dot" />文字对话<span>本地历史</span></div>
  </aside>;
}
