import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, GitBranch, RotateCcw, RefreshCw } from 'lucide-react';
import type { ProjectGit } from './useProjectGit';
import { GitRemoteStatus } from './GitRemoteStatus';
import './git.css';

export function ChatGitBar({ git, locked }: { git: ProjectGit; locked: boolean }) {
  const { status, busy, notice, error } = git; const disabled = locked || !!busy;
  const [confirming, setConfirming] = useState(false); const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (confirming) dialog.current?.showModal(); else dialog.current?.close(); }, [confirming]);
  return <section className="chat-git" aria-label="工程 Git 状态">
    <details className="git-overview"><summary><GitBranch size={14} aria-hidden="true" /><span className="git-branch">{status?.branch ?? 'Git'}</span>
      <span>{status ? status.changed.length ? `${status.changed.length} 项工程修改` : '无未提交工程修改' : '读取中…'}</span>
      </summary>
      <div className="git-overview-content">
        {!!status?.changed.length && <ul>{status.changed.map(path => <li key={path}>{path}</li>)}</ul>}
        <p>显示整个仓库的修改，忽略规则由 .gitignore 决定。</p>
      </div>
    </details>
    <div className="git-remote-line"><GitRemoteStatus status={status} /></div>
    <div className="git-actions">
      <button disabled={disabled || !status?.changed.length} onClick={() => { void git.run('commit'); }}><Check size={14} aria-hidden="true" />{busy === 'commit' ? '提交中…' : '提交'}</button>
      <button disabled={disabled || !status?.changed.length || !status.head} onClick={() => setConfirming(true)}><RotateCcw size={14} aria-hidden="true" />撤销</button>
      {!!status?.remotes.length && <>
        <button disabled={disabled || !status.remote || !!status.changed.length} onClick={() => { void git.run('pull'); }}><ArrowDown size={14} aria-hidden="true" />{busy === 'pull' ? '拉取中…' : '拉取'}</button>
        <button disabled={disabled || !status.remote || !status.head} onClick={() => { void git.run('push'); }}><ArrowUp size={14} aria-hidden="true" />{busy === 'push' ? '推送中…' : '推送'}</button>
      </>}
      <button className="git-refresh" aria-label="刷新 Git 状态" title="刷新本地 Git 状态" disabled={disabled} onClick={() => { void git.load(); }}><RefreshCw size={14} aria-hidden="true" /></button>
    </div>
    {(notice || error) && <p role={error ? 'alert' : 'status'} className={error ? 'sidebar-error' : 'git-notice'}>{error || notice}</p>}
    <dialog ref={dialog} className="git-discard-dialog" aria-labelledby="git-discard-title" onCancel={() => setConfirming(false)} onClose={() => setConfirming(false)}>
      <h2 id="git-discard-title">撤销未提交的工程修改？</h2>
      <p>将撤销整个仓库中的未提交修改，包括暂存内容和新增文件。未被跟踪的忽略文件会保留，提交历史不变。</p>
      <ul>{status?.changed.map(path => <li key={path}>{path}</li>)}</ul>
      <div className="ai-buttons"><button className="ai-button" autoFocus onClick={() => setConfirming(false)}>取消</button>
        <button className="ai-button" disabled={disabled} onClick={() => { setConfirming(false); void git.run('discard'); }}>确认撤销</button></div>
    </dialog>
  </section>;
}
