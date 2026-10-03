import type { ProjectGit } from './useProjectGit';
import { GitRemoteStatus } from './GitRemoteStatus';
import './git.css';

export function GitPanel({ git, locked }: { git: ProjectGit; locked: boolean }) {
  const { status, busy, notice, error } = git; const disabled = locked || !!busy;
  return <section className="settings-section" aria-label="Git 历史">
    <header className="settings-heading"><h2>Git 历史</h2><span>{status?.branch ?? '读取中'}</span></header>
    <p className="ai-hint"><GitRemoteStatus status={status} /></p>
    {status?.remotes.map(remote => <p key={remote.name} className="ai-hint" style={{ overflowWrap: 'anywhere' }}>{remote.name} · {remote.url}</p>)}
    <p className="ai-hint">远程状态基于最近一次查询{status?.fetchedAt ? `（${new Date(status.fetchedAt).toLocaleString()}）` : ''}。提交、撤销、拉取和推送在对话页操作。</p>
    <div className="ai-buttons"><button className="ai-button" disabled={disabled} onClick={() => { void git.load(); }}>刷新 Git 状态</button>
      {!!status?.remote && <button className="ai-button" disabled={disabled} onClick={() => { void git.run('fetch'); }}>{busy === 'fetch' ? '查询中…' : '查询远程状态'}</button>}</div>
    {!!status?.otherChanged.length && <p className="ai-hint">其他文件有 {status.otherChanged.length} 项未提交修改；框架不会自动提交或撤销这些文件。</p>}
    {!!status?.remoteCommits.length && <><h3>远程待拉取记录</h3><ol className="git-history">{status.remoteCommits.map(commit => <li key={commit.id}>
      <p>{commit.message}</p><small>{commit.id.slice(0, 8)} · 远程</small><time dateTime={commit.createdAt}>{new Date(commit.createdAt).toLocaleString()}</time>
    </li>)}</ol></>}
    <h3>最近提交 · 最新在前</h3>
    <ol className="git-history">{status?.commits.map(commit => <li key={commit.id}>
      <p>{commit.message}</p><small>{commit.id.slice(0, 8)} · {commit.remoteState === 'pushed' ? '已在远程' : commit.remoteState === 'unknown' ? '远程状态待查询' : '仅本地'}</small>
      <time dateTime={commit.createdAt}>{new Date(commit.createdAt).toLocaleString()}</time>
      <div><button className="ai-button" disabled={disabled || !!status.changed.length} onClick={() => { void git.run('restore', { commitId: commit.id }); }}>恢复此提交内容</button></div>
    </li>)}</ol>
    {!!status?.changed.length && <p className="ai-hint">恢复历史前请先提交或撤销当前工程修改。</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="sidebar-error">{error}</p>}
  </section>;
}
