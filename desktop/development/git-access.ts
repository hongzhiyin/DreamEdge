import type { ProjectContext, WorkspaceProject } from '../../shared/contracts';
import { WorkspaceApi } from '../workspace/api';
import { currentVersionState } from '../changes/current';
import { repositoryState } from '../git/state';
import { modelDefinition, shortText } from './context';
import { readGit } from './git-read';
import { restorePlan, type RestorePlan } from './git-restore-plan';
import type { GitIntent } from './git-intent';

export interface GitExecutionPlan { expectedStateHash: string; restoreCommitId?: string }
export class AgentGitAccess {
  message?: string; restore?: RestorePlan; plan?: GitExecutionPlan;
  constructor(private readonly workspace: WorkspaceApi, private readonly id: string, private readonly context: ProjectContext,
    private readonly intent: GitIntent) {}
  async capture(project: WorkspaceProject) {
    const status = await repositoryState(project, (await currentVersionState(project)).stateHash);
    if (this.plan && this.plan.expectedStateHash !== status.stateHash) throw new Error('Git 工程状态已变化，请重新发送请求。');
    this.plan ??= { expectedStateHash: status.stateHash }; return status;
  }
  async execute(name: string, args: Record<string, unknown>, signal: AbortSignal, guard: (value: unknown) => void) {
    return this.workspace.withProject(this.id, async project => {
      signal.throwIfAborted(); const status = await this.capture(project);
      if (JSON.stringify(modelDefinition(project.definition)) !== JSON.stringify(this.context.definition)) throw new Error('工程描述已变化，请重新发送请求。');
      if (['git_status', 'git_log', 'git_diff'].includes(name)) { const result = await readGit(project, name, args); guard(result); return result; }
      if (name === 'git_commit') {
        if (!this.intent.commit) throw new Error('本轮用户没有要求提交 Git；请仅查阅，不修改历史。');
        guard(args); this.message = shortText(args.message, 'Git 提交说明', 500);
        return { queued: true, detail: '构建和应用成功后提交当前业务仓库，不推送远程。' };
      }
      if (name !== 'git_restore' || !this.intent.restore) throw new Error('本轮用户没有明确要求恢复 Git 历史。');
      if (this.restore) throw new Error('本轮已暂存恢复请求，请结束本轮，不重复恢复。');
      this.restore = await restorePlan(project, this.context, args.commitId, args.paths, guard);
      this.plan!.restoreCommitId = this.restore.commitId;
      return { queued: true, commitId: this.restore.commitId, paths: this.restore.files.map(file => file.path),
        preserveUncommitted: !!status.changed.length, detail: '先构建校验；如有当前修改，保存 Git 备份提交后恢复，HEAD 历史不回退。完成时用 propose_changes 提交 files: []。' };
    });
  }
}
