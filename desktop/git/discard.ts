import type { WorkspaceProject } from '../../shared/contracts';
import { applyState } from '../changes/apply';
import { git } from './command';
import { gitSnapshot } from './history';
import { currentVersionState } from '../changes/current';
import { repositoryState } from './state';

export async function restoreRepository(project: WorkspaceProject, profile: string, target: string | null, sourceHash: string,
  expectedGitHash: string, signal: AbortSignal, discard: boolean): Promise<void> {
  if (!target) throw new Error('工程还没有 Git 提交，无法撤销到 HEAD。');
  const root = project.rootDirectory; const snapshot = await gitSnapshot(project, target);
  const ignored = (await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const targetPaths = (await git(root, ['ls-tree', '-r', '--name-only', '-z', target])).split('\0').filter(Boolean);
  if (ignored.some(local => targetPaths.some(path => local === path || local.startsWith(path + '/') || path.startsWith(local + '/')))) {
    throw new Error('恢复内容会覆盖本机忽略文件，请先备份或移动冲突文件。');
  }
  const current = await currentVersionState(project);
  if ((await repositoryState(project, current.stateHash)).stateHash !== expectedGitHash) throw new Error('工程状态已变化，请刷新 Git 状态后操作。');
  for (const path of ignored) if (path.startsWith('src/') && Object.hasOwn(current.files, path.slice(4))) snapshot.files[path.slice(4)] = current.files[path.slice(4)];
  await applyState(project, profile, snapshot.files, snapshot.definition, sourceHash, signal);
  // Finish checkout after the source transaction, without moving HEAD or following submodules.
  await git(root, ['restore', `--source=${target}`, ...(discard ? ['--staged'] : []), '--worktree', '--', '.']);
  if (discard) for (let offset = 0; offset < untracked.length; offset += 100) {
    // Only clean files that were non-ignored before restoring .gitignore.
    await git(root, ['clean', '-f', '-d', '--', ...untracked.slice(offset, offset + 100)]);
  }
}
