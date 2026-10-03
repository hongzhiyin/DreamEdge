import type { GitRequest, GitResult } from '../../packages/sdk/src/git';
import { WorkspaceApi } from '../workspace/api';
import { currentVersionState } from '../changes/current';
import { applyBuild, applyState } from '../changes/apply';
import { shortText } from '../development/context';
import { commitGit, gitStatus } from './repository';
import { gitHistory, gitSnapshot } from './history';

export class ProjectGitApi {
  private closed = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly workspace: WorkspaceApi, private readonly profile: string, private readonly changed: (buildId?: string) => void = () => {}) {}
  async execute(input: unknown): Promise<GitResult> {
    if (this.closed) throw new Error('Git 服务已关闭。');
    const request = structuredClone(input) as GitRequest; const controller = new AbortController(); this.active.add(controller);
    try {
      const result = await this.workspace.mutateProject(request.projectId, async project => {
        controller.signal.throwIfAborted();
        const current = await currentVersionState(project);
        if (request.operation === 'status') return { ...await gitStatus(project.rootDirectory), stateHash: current.stateHash, commits: await gitHistory(project.rootDirectory) };
        if (request.operation === 'applyBuild') { await applyBuild(project, this.profile, request.buildId, controller.signal); return { applied: true as const }; }
        if (request.expectedStateHash !== current.stateHash) throw new Error('工程状态已变化，请刷新 Git 状态后操作。');
        if (request.operation === 'commit') return { applied: true as const,
          commitId: await commitGit(project.rootDirectory, shortText(request.message, 'Git 提交说明', 500), controller.signal) };
        if (request.operation !== 'restore') throw new Error('不支持的 Git 操作。');
        if ((await gitStatus(project.rootDirectory)).changed.length) throw new Error('工程有未提交的修改，请先提交后再恢复历史内容。');
        const snapshot = await gitSnapshot(project, request.commitId);
        await applyState(project, this.profile, snapshot.files, snapshot.definition, current.stateHash, controller.signal);
        return { applied: true as const };
      });
      if (request.operation === 'restore' || request.operation === 'applyBuild') this.changed(request.operation === 'applyBuild' ? request.buildId : undefined);
      return result;
    } finally { this.active.delete(controller); }
  }
  async dispose(): Promise<void> { this.closed = true; for (const controller of this.active) controller.abort('closed'); }
}
