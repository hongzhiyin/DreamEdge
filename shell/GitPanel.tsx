import { useEffect, useRef, useState } from 'react';
import type { GitStatus } from '../packages/sdk/src/git';

export function GitPanel({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<GitStatus>(); const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const load = async () => {
    const value = await window.dreamEdge.git({ operation: 'status', projectId }) as GitStatus;
    if (alive.current) setStatus(value);
  };
  useEffect(() => {
    alive.current = true;
    const reload = () => { void load().catch(() => {}); };
    reload(); const stop = window.dreamEdge.onContextChanged(reload);
    return () => { alive.current = false; stop(); };
  }, [projectId]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); await load(); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'Git 操作失败。'); }
    finally { if (alive.current) setBusy(false); }
  }
  return <section className="settings-section" aria-label="Git 历史">
    <header className="settings-heading"><h2>Git 历史</h2><span>{status ? status.changed.length ? `${status.changed.length} 项修改` : '已提交' : '读取中'}</span></header>
    <div className="ai-form">
      <p className="ai-hint">工程目录中的独立 Git 仓库 · {status?.branch ?? '读取中'}</p>
      <label>提交说明<input value={message} disabled={busy} onChange={event => setMessage(event.target.value)} maxLength={500} /></label>
      <div className="ai-buttons">
        <button className="ai-button" disabled={busy || !status?.changed.length || !message.trim()} onClick={() => { void run(async () => {
          await window.dreamEdge.git({ operation: 'commit', projectId, message, expectedStateHash: status!.stateHash }); setMessage(''); setNotice('工程修改已提交 Git。');
        }); }}>提交当前修改</button>
        <button className="ai-button" disabled={busy} onClick={() => { void run(async () => {}); }}>刷新 Git 状态</button>
      </div>
      {status?.commits.map(commit => <div key={commit.id} className="ai-turn">
        <p>{commit.message} · {commit.id.slice(0, 8)}</p>
        <button className="ai-button" disabled={busy || !!status.changed.length} onClick={() => { void run(async () => {
          await window.dreamEdge.git({ operation: 'restore', projectId, commitId: commit.id, expectedStateHash: status.stateHash });
          setNotice('已恢复提交内容，恢复结果保留为工作区修改，可再提交。');
        }); }}>恢复此提交内容</button>
      </div>)}
      {status?.changed.length ? <p className="ai-hint">恢复历史前请先提交当前修改。</p> : null}
      {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="sidebar-error">{error}</p>}
    </div>
  </section>;
}
