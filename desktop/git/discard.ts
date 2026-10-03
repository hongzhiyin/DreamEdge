import type { WorkspaceProject } from '../../shared/contracts';
import { applyState } from '../changes/apply';
import { git, MANAGED } from './command';
import { gitSnapshot } from './history';
import { currentVersionState } from '../changes/current';
import { repositoryState } from './state';

export async function discardGit(project: WorkspaceProject, profile: string, head: string | null, sourceHash: string, expectedGitHash: string, signal: AbortSignal) {
  if (!head) throw new Error('工程还没有 Git 提交，无法撤销到 HEAD。');
  const snapshot = await gitSnapshot(project, head);
  const ignored = (await git(project.rootDirectory, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', 'src'])).split('\0').filter(Boolean);
  const current = await currentVersionState(project);
  if ((await repositoryState(project, current.stateHash)).stateHash !== expectedGitHash) throw new Error('工程状态已变化，请刷新 Git 状态后操作。');
  for (const path of ignored) if (Object.hasOwn(current.files, path.slice(4))) snapshot.files[path.slice(4)] = current.files[path.slice(4)];
  await applyState(project, profile, snapshot.files, snapshot.definition, sourceHash, signal);
  // Reset only managed paths; unrelated staged files and ignored credentials stay intact.
  const paths: string[] = [];
  for (const name of MANAGED) if ((await git(project.rootDirectory, ['ls-tree', head, '--', name])).trim()) paths.push(name);
  await git(project.rootDirectory, ['restore', `--source=${head}`, '--staged', '--worktree', '--', ...paths]);
}
