import { useEffect, useRef, useState } from 'react';
import { FolderLock, X } from 'lucide-react';
import type { ChatView } from '../src/chat/types.js';
import { FileScopeForm } from './FileScopeForm.js';
import { destinationLabel, grantStatus } from './file-scope-state.js';
import { useScopeActions, useScopeClock } from './use-file-scopes.js';
import { DeviceAccess } from './DeviceAccess.js';

export function FileScopes({ view, refresh }: { view: ChatView; refresh(id: string): Promise<void> }) {
  const [open, setOpen] = useState(false); const trigger = useRef<HTMLButtonElement>(null); const close = useRef<HTMLButtonElement>(null);
  const actions = useScopeActions(view.sessionId, refresh); const scope = view.fileScope;
  const now = useScopeClock(scope);
  const saved = !['failed', 'pending'].includes(view.saving.status);
  const active = saved ? scope?.grants.filter(grant => grantStatus(grant, scope.destination, now) === '授权中').length ?? 0 : 0;
  const supported = Boolean(scope && (scope.device?.mode === 'account' || (window.dreamedge.chooseDirectory && window.dreamedge.revokeDirectory)));
  function dismiss() { setOpen(false); trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [open]);
  return <div className="file-scope-control">
    <button ref={trigger} className="scope-trigger" aria-expanded={open} aria-controls="file-scope-panel"
      onClick={() => setOpen(!open)}><FolderLock size={16} />文件范围<span>{scope?.device?.mode === 'account' ? '账户权限' : scope?.device?.enabled ? '整机' : active}</span></button>
    {open && <section id="file-scope-panel" className="file-scope-panel" aria-label="文件范围设置">
      <header><h2>文件范围</h2><button ref={close} className="icon-button" aria-label="关闭文件范围" onClick={dismiss}><X size={18} /></button></header>
      <p className="scope-context">当前会话：{view.title}</p>
      {scope && <p className="scope-context">文件内容发送到：{destinationLabel(scope.destination)}</p>}
      {!supported ? <p role="status">当前宿主不支持目录授权。</p> : <>
        {scope?.device?.available && (scope.device.mode === 'account' || window.dreamedge.setDeviceAccess) && <DeviceAccess device={scope.device}
          disabled={!view.acceptingCommands || (!saved && !scope.device.enabled)} busy={actions.busy}
          change={enabled => { void actions.act(() => window.dreamedge.setDeviceAccess!(view.sessionId, enabled)); }} />}
        {!scope?.device?.enabled && <FileScopeForm disabled={!view.acceptingCommands || !saved} busy={actions.busy}
          choose={options => { void actions.act(() => window.dreamedge.chooseDirectory!(view.sessionId, options), '已取消选择，未新增授权。'); }} />}
        {actions.error && <p className="scope-error" role="alert">{actions.error}</p>}
        {actions.notice && <p role="status" className="scope-help">{actions.notice}</p>}
        {!scope?.device?.enabled && <div className="scope-grants" aria-label="已授权目录">
          {!scope!.grants.some(g => !g.device) && <p className="scope-help">尚未授权目录。文件工具不会访问其他本机文件。</p>}
          {scope!.grants.filter(grant => !grant.device).map(grant => {
            const policyStatus = grantStatus(grant, scope!.destination, now);
            const status = policyStatus === '授权中' && !saved ? '授权未保存' : policyStatus;
            return <article key={grant.grantId} className="scope-grant" data-status={status}>
              <p className="scope-path">{grant.path}</p>
              <p>{grant.mode === 'read' ? '只读' : '读写'} · {status} · {grant.remember ? '重启后保留' : '本次运行有效'}</p>
              {grant.expiresAt !== undefined && <p>到期：{new Date(grant.expiresAt).toLocaleString()}</p>}
              <details><summary>授权详情</summary><p>模型服务：{destinationLabel(grant.destination)}</p>
                <p>排除路径：{grant.excludes.join('、') || '未添加额外排除路径'}；默认排除规则始终生效。</p>
                <p>实际访问时重新校验目录身份和权限。撤销后，已经进入对话的文件内容仍保留在历史中。</p></details>
              {grant.revokedAt === undefined && <button className="scope-revoke" disabled={actions.busy || !view.acceptingCommands}
                onClick={() => { void actions.act(() => window.dreamedge.revokeDirectory!(view.sessionId, grant.grantId)); }}>撤销授权</button>}
            </article>;
          })}
        </div>}
      </>}
    </section>}
  </div>;
}
