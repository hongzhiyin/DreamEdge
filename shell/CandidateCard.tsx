import { useEffect, useState } from 'react';
import type { CandidateInspection, CandidateReference } from '../shared/contracts';
import { candidateDiff } from './candidate-diff';

export function CandidateCard({ projectId, reference }: { projectId: string; reference: CandidateReference }) {
  const [candidate, setCandidate] = useState<CandidateInspection>(); const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void window.dreamEdge.development({ operation: 'candidate', projectId, ...reference }).then(value => {
      if (alive) setCandidate(value as CandidateInspection);
    }).catch(error => { if (alive) setError(error.message); });
    return () => { alive = false; };
  }, [projectId, reference.sessionId, reference.turnId]);
  return <section className="ai-candidate" aria-label="修改记录">
    <h3>修改记录</h3>
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
          <p className="ai-hint">修改内容</p><pre>{file.after}</pre>
        </details>
      </details>;
    })}
    {error && <p role="alert" className="sidebar-error">{error}</p>}
  </section>;
}
