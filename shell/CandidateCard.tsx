import { useEffect, useState } from 'react';
import type { CandidateInspection, CandidateReference } from '../shared/contracts';
import { useCandidateBuild } from './useCandidateBuild';
import { candidateDiff } from './candidate-diff';

const phases = { resolving: '正在准备依赖', installing: '正在安装依赖', compiling: '正在构建', complete: '构建结束' };
export function CandidateCard({ projectId, reference, busyChanged }: { projectId: string; reference: CandidateReference; busyChanged: (busy: boolean) => void }) {
  const [candidate, setCandidate] = useState<CandidateInspection>(); const [error, setError] = useState('');
  const build = useCandidateBuild(projectId); const running = build.record?.status === 'running';
  useEffect(() => {
    let alive = true;
    void window.dreamEdge.development({ operation: 'candidate', projectId, ...reference }).then(value => {
      if (alive) setCandidate(value as CandidateInspection);
    }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [projectId, reference.sessionId, reference.turnId]);
  useEffect(() => { busyChanged(build.busy || running); return () => busyChanged(false); }, [build.busy, running, busyChanged]);
  return <section className="ai-candidate" aria-label="候选修改">
    <h3>候选修改</h3>
    {!candidate && !error && <p role="status">正在读取修改…</p>}
    {candidate?.files.map(file => {
      const diff = candidateDiff(file.before, file.after);
      return <details className="ai-file-change" key={file.path}>
        <summary>{file.path}<span>{file.before === null ? '新文件' : '修改'}</span></summary>
        <pre aria-label={`修改差异 ${file.path}`} className="ai-diff">{diff.slice(0, 240).map((line, index) => <span key={index} className={`diff-${line.kind}`}>
          {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '} {line.text}{'\n'}
        </span>)}</pre>
        {diff.length > 240 && <p className="ai-hint">差异较长，完整内容见下方。</p>}
        <details className="ai-full-source"><summary>查看完整内容</summary>
          <p className="ai-hint">原内容</p><pre>{file.before ?? '（新文件）'}</pre>
          <p className="ai-hint">候选内容</p><pre>{file.after}</pre>
        </details>
      </details>;
    })}
    {candidate?.stale && <p className="ai-hint">{candidate.reason}</p>}
    {candidate && !build.saved && <div className="ai-buttons">
      <button className="ai-button primary" disabled={build.busy || running || candidate.stale || !candidate.files.length}
        onClick={() => { void build.start(undefined, reference); }}>构建此候选</button>
      {running && <button className="ai-button" disabled={build.busy} onClick={() => { void build.cancel(); }}>取消构建</button>}
      {build.record?.status === 'succeeded' && <>
        <button className="ai-button" disabled={build.busy} onClick={() => { void build.preview(); }}>预览候选</button>
        <button className="ai-button" disabled={build.busy} onClick={() => { void build.confirm(); }}>确认保存</button>
      </>}
    </div>}
    <div aria-live="polite" className="ai-build-feedback">
      {running && <p role="status">{phases[build.record!.phase]}…</p>}
      {build.busy && !running && <p role="status">正在处理候选…</p>}
      {build.saved && <p role="status">候选已保存到工程，源码版本已更新。</p>}
      {!build.busy && !running && !build.saved && build.record && <p role="status">{build.record.status === 'succeeded' ? '构建成功，请预览并确认保存。' : build.record.status === 'cancelled' ? '构建已取消，工程未修改。' : '构建失败，工程未修改。'}</p>}
      {build.record && <ul className="ai-logs" aria-label="候选构建日志">{build.record.logs.slice(-3).map((log, index) => <li key={index} className={log.level === 'error' ? 'ai-error-log' : ''}>{log.message}</li>)}</ul>}
      {(error || build.error) && <p role="alert" className="sidebar-error">{error || build.error}</p>}
    </div>
  </section>;
}
