import type { GitRequest, GitResult } from '../../packages/sdk/src/git';
import { WorkspaceApi } from '../workspace/api';
import { currentVersionState } from '../changes/current';
import { applyBuild } from '../changes/apply';
import { shortText } from '../development/context';
import { commitGit } from './repository';
import { projectGitStatus, repositoryState } from './state';
import { restoreRepository } from './discard';
import { syncGit } from './sync';

export class ProjectGitApi {
  private closed = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly workspace: WorkspaceApi, private readonly profile: string, private readonly changed: (buildId?: string) => void = () => {},
    private readonly assertIdle: () => void = () => {}) {}
  async execute(input: unknown): Promise<GitResult> {
    if (this.closed) throw new Error('Git 服务已关闭。');
    const request = structuredClone(input) as GitRequest; const controller = new AbortController(); this.active.add(controller);
    try {
      const result = await this.workspace.mutateProject(request.projectId, async project => {
        controller.signal.throwIfAborted();
        const current = await currentVersionState(project);
        if (request.operation === 'status') return projectGitStatus(project, current.stateHash);
        this.assertIdle();
        if (request.operation === 'applyBuild') { await applyBuild(project, this.profile, request.buildId, controller.signal); return { applied: true as const }; }
        const status = await repositoryState(project, current.stateHash);
        if (request.expectedStateHash !== status.stateHash) throw new Error('工程状态已变化，请刷新 Git 状态后操作。');
        if (request.operation === 'commit') return { applied: true as const,
          commitId: await commitGit(project.rootDirectory, shortText(request.message, 'Git 提交说明', 500), controller.signal) };
        if (request.operation === 'discard') { await restoreRepository(project, this.profile, status.head, current.stateHash, status.stateHash, controller.signal, true); return { applied: true as const }; }
        if (['fetch', 'pull', 'push'].includes(request.operation)) {
          await syncGit(project, request.operation as 'fetch' | 'pull' | 'push', request.expectedStateHash, controller.signal); return { applied: true as const };
        }
        if (request.operation !== 'restore') throw new Error('不支持的 Git 操作。');
        if (status.changed.length) throw new Error('工程有未提交的修改，请先提交后再恢复历史内容。');
        await restoreRepository(project, this.profile, request.commitId, current.stateHash, status.stateHash, controller.signal, false);
        return { applied: true as const };
      });
      if (['restore', 'discard', 'pull', 'applyBuild'].includes(request.operation)) this.changed(request.operation === 'applyBuild' ? request.buildId : undefined);
      return result;
    } finally { this.active.delete(controller); }
  }
  async dispose(): Promise<void> { this.closed = true; for (const controller of this.active) controller.abort('closed'); }
}
