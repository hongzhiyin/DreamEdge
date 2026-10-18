import { useEffect, useRef, useState } from 'react';
import { Plug, X } from 'lucide-react';
import { useMcp } from './use-mcp.js';
import { McpConfigForm } from './McpConfigForm.js';
import { McpServerCard } from './McpServerCard.js';
import { McpContext } from './McpContext.js';
export function McpControls({ sessionId, disabled, onRestricted }: { sessionId: string; disabled: boolean; onRestricted(value: boolean): void }) {
  const [open, setOpen] = useState(false), [editing, setEditing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const control = useMcp(sessionId, open); const { view } = control;
  useEffect(() => { onRestricted(window.dreamedgeMcp ? !view || view.mode !== 'local' : false); }, [view, onRestricted]);
  useEffect(() => { setEditing(false); setOpen(false); }, [sessionId]);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  if (!window.dreamedgeMcp) return null;
  function close() { setOpen(false); trigger.current?.focus(); }
  const locked = disabled || control.busy;
  const visible = view?.servers.filter(s => !s.revoked || view.settings?.serverIds.includes(s.config.serverId) || view.binding?.identity.serverId === s.config.serverId) ?? [];
  return <div className="mcp-control"><button ref={trigger} className="scope-trigger" onClick={() => setOpen(true)} aria-haspopup="dialog">
    <Plug size={16} />MCP{visible.length ? ` · ${visible.length}` : ''}</button>
    <dialog ref={dialog} className="mcp-dialog" onCancel={close} aria-label="MCP 连接">
      <header className="mcp-header"><div><h2>MCP</h2><p>复制应用提供的 JSON，保存后即可对话。</p></div>
        <button className="icon-button" aria-label="关闭 MCP" onClick={close}><X size={18} /></button></header>
      <div className="mcp-body">
        {control.busy && <p role="status">正在连接…</p>}
        {(control.error || view?.settings?.error) && <p className="scope-error" role="alert">{control.error || view?.settings?.error}</p>}
        {view ? <>
          {(editing || !visible.length) && <McpConfigForm key={sessionId} text={view.settings?.text ?? '{"mcpServers":{}}'} disabled={locked}
            cancel={() => setEditing(false)} save={text => control.act('saveConfig', { text })} />}
          {visible.length > 0 && !editing && <button disabled={locked} onClick={() => setEditing(true)}>编辑 JSON 配置</button>}
          {!editing && visible.map(server => <McpServerCard key={server.config.serverId} server={server} disabled={locked} act={control.act} />)}
          <details className="mcp-context"><summary>高级</summary>
            {view.settings && <p className="scope-help">配置文件：{view.settings.path}</p>}
            <p className="scope-help">模型：{view.destination.model}</p>
            {view.notices.map(n => <p key={n}>{n}</p>)}
            {view.binding && <button disabled={locked} onClick={() => { void control.act('unpin'); }}>使用全部已配置 MCP</button>}
            <button disabled={control.busy} onClick={() => { void control.refresh(); }}>重新读取配置</button>
            <McpContext view={view} disabled={locked} act={control.act} />
          </details>
        </> : <p role="status">正在读取配置…</p>}
      </div>
    </dialog>
  </div>;
}
