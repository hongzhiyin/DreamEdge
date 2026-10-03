import type { GitStatus } from '../shared/contracts';

export function GitRemoteStatus({ status }: { status?: GitStatus }) {
  if (!status) return <span>读取 Git 状态中…</span>;
  if (!status.remotes.length) return <span>未配置远程仓库</span>;
  if (!status.remote) return <span>{status.remotes.length} 个远程仓库 · {status.branch === 'HEAD' ? '当前未处于分支' : '未选择跟踪远程'}</span>;
  const remote = status.remote;
  return <span>{remote.name}/{remote.branch} · {!remote.exists ? '远程分支待查询或发布' : remote.ahead || remote.behind
    ? `待推送 ${remote.ahead} · 待拉取 ${remote.behind}` : '已同步'}{!remote.tracking ? ' · 未设置跟踪' : ''}</span>;
}
