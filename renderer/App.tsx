import { McpControls } from './McpControls.js';
import { useEffect, useState } from 'react';
import { PanelLeft } from 'lucide-react';
import type { ThinkingLevel } from '../src/model/types.js';
import { Composer } from './Composer.js';
import { Messages } from './Messages.js';
import { Sidebar } from './Sidebar.js';
import { useChat } from './use-chat.js';
import { useDrafts } from './use-drafts.js';
import { FileScopes } from './FileScopes.js';

export function App() {
  const chat = useChat();
  const embedded = window.dreamedgeEmbedded === true;
  const { drafts, update } = useDrafts();
  const [levels, setLevels] = useState<Record<string, ThinkingLevel>>({});
  const [externalBound, setExternalBound] = useState(true);
  const [sidebar, setSidebar] = useState(!embedded);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!embedded && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !chat.pending && chat.view?.acceptingCommands) {
        event.preventDefault(); void chat.create();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [chat.create, chat.pending, chat.view?.acceptingCommands]);
  const view = chat.view;
  const draft = drafts[chat.selectedId] ?? '';
  const level = levels[chat.selectedId] ?? chat.connection?.defaultLevel ?? 'high';
  async function send(): Promise<void> {
    const id = chat.selectedId;
    if (await chat.send(draft, level)) update(id, '', draft);
  }
  return <div className={`app ${embedded ? 'embedded' : 'standalone'} ${sidebar ? '' : 'sidebar-hidden'}`}>
    {!embedded && <div className="titlebar"><span>DreamEdge</span></div>}
    <div className="workspace">
      {!embedded && sidebar && <Sidebar sessions={chat.sessions} selected={chat.selectedId}
        pending={chat.pending || !view?.acceptingCommands} choose={chat.select} create={chat.create} />}
      <main className="chat-main">{!embedded && <header className="chat-header">
        <button className="icon-button" aria-label={sidebar ? '收起会话列表' : '展开会话列表'} onClick={() => setSidebar(!sidebar)}><PanelLeft size={18} /></button>
        <span className="chat-title">{view?.title ?? '新对话'}</span>
        {view && <McpControls key={view.sessionId} sessionId={view.sessionId} disabled={chat.pending || !!view.activeRunId || !view.acceptingCommands || view.saving.status !== 'saved'} onRestricted={setExternalBound} />}
        {view && !externalBound && <FileScopes key={view.sessionId} view={view} refresh={chat.refresh} />}
      </header>}
      {embedded && <h1 className="sr-only">{view?.title ?? '新对话'}</h1>}
      {embedded && <div className="launch-notice" role="status">{view?.externalContext === 'mcp-read' ? '应用会话 · 已授权读取绑定窗口的内容' : '应用会话 · 文字对话已连接，应用内容与工具尚未接入'}</div>}
      {chat.error && <div className="action-error" role="alert">{chat.error}</div>}
      {view && chat.connection ? <>
        <Messages view={view} pending={chat.pending} retry={chat.retry} approve={chat.approve} />
        <Composer view={view} connection={chat.connection} draft={draft} change={value => update(chat.selectedId, value)}
          level={level} setLevel={value => setLevels(previous => ({ ...previous, [chat.selectedId]: value }))}
          pending={chat.pending} send={send} stop={chat.stop} retrySave={chat.retrySave} />
      </> : <div className="loading-state">{chat.error ? '聊天服务暂不可用' : '正在读取对话…'}</div>}
      </main>
    </div>
  </div>;
}
