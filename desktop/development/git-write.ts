import type { WorkspaceProject } from '../../shared/contracts';
import { currentVersionState } from '../changes/current';
import { repositoryState } from '../git/state';
import { commitGit } from '../git/repository';
import { projectFilePath } from '../workspace/project-files';
import type { GitExecutionPlan } from './git-access';

export async function checkedGitState(project: WorkspaceProject, plan: GitExecutionPlan) {
  const status = await repositoryState(project, (await currentVersionState(project)).stateHash);
  if (status.stateHash !== plan.expectedStateHash) throw new Error('Git 工程状态已变化，未覆盖新修改，请重新查阅后操作。');
  return status;
}
export function assertCommitPaths(paths: string[]) {
  for (const path of paths) {
    if (path === '.dreamedge/project.json') continue;
    try { projectFilePath(path); } catch { throw new Error('待提交内容包含私有配置、凭据或内部目录；请先处理这些文件，AI 不会把它们写入 Git。'); }
  }
}
export async function checkpointRestore(project: WorkspaceProject, plan: GitExecutionPlan, signal: AbortSignal): Promise<string | null> {
  const status = await checkedGitState(project, plan);
  if (!plan.restoreCommitId || !status.changed.length) return null;
  assertCommitPaths(status.changed);
  const id = await commitGit(project.rootDirectory, `Checkpoint before restore ${plan.restoreCommitId.slice(0, 8)}`, signal);
  plan.expectedStateHash = (await repositoryState(project, (await currentVersionState(project)).stateHash)).stateHash;
  return id;
}
export async function checkedCommit(project: WorkspaceProject, message: string, signal: AbortSignal, plan?: GitExecutionPlan) {
  const status = plan ? await checkedGitState(project, plan) : await repositoryState(project, (await currentVersionState(project)).stateHash);
  assertCommitPaths(status.changed); return commitGit(project.rootDirectory, message, signal);
}
