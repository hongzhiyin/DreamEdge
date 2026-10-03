import type { CSSProperties } from 'react';
import type { GitCommit } from '../shared/contracts';
import { commitGraph } from './gitGraph';
import './git-history.css';

const x = (column: number) => 10 + column * 14;
function timeLabel(value: string) {
  const date = new Date(value); const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function GitHistory({ commits, head, remote = false }: { commits: GitCommit[]; head?: string | null; remote?: boolean }) {
  const graph = commitGraph(commits);
  if (!commits.length) return <p className="ai-hint">暂无提交记录。</p>;
  return <ol className="git-history" aria-label={remote ? '远程提交时间轴' : '提交时间轴'} style={{ '--git-graph-width': `${graph.width}px` } as CSSProperties}>
    {commits.map((commit, index) => {
      const row = graph.rows[index]; const current = commit.id === head;
      const label = remote ? '远程' : commit.remoteState === 'pushed' ? '已在远程' : commit.remoteState === 'unknown' ? '待查询' : '仅本地';
      return <li key={commit.id} data-commit-id={commit.id} data-current={current || undefined}>
        <svg className="git-graph" width={graph.width} height="52" viewBox={`0 0 ${graph.width} 52`} aria-hidden="true">
          {row.incoming && <path d={`M ${x(row.column)} 0 V 14`} />}
          {row.edges.map((edge, edgeIndex) => <path key={edgeIndex} className={edge.continuation ? 'is-continuation' : undefined}
            d={`M ${x(edge.from)} ${edge.start === 'top' ? 0 : 14} C ${x(edge.from)} 30 ${x(edge.to)} 30 ${x(edge.to)} 52`} />)}
          {current && <circle className="git-head-ring" cx={x(row.column)} cy="14" r="6" />}
          <circle className="git-commit-node" cx={x(row.column)} cy="14" r="3" />
        </svg>
        <div className="git-commit-content">
          <p className="git-commit-message" title={commit.message}>{commit.message}</p>
          <div className="git-commit-meta"><code title={commit.id}>{commit.id.slice(0, 8)}</code>{current && <span className="git-head-label">HEAD</span>}<span>{label}</span>
            <time dateTime={commit.createdAt} title={new Date(commit.createdAt).toLocaleString()}>{timeLabel(commit.createdAt)}</time></div>
          {(commit.parents?.length ?? 0) > 1 && <span className="sr-only">合并提交，{commit.parents!.length} 个父提交</span>}
        </div>
      </li>;
    })}
  </ol>;
}
