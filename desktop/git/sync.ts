import type { WorkspaceProject } from '../../shared/contracts';
import { currentVersionState } from '../changes/current';
import { git } from './command';
import { assertRemoteUrl, fetchRemote, remoteRef } from './remote';
import { repositoryState } from './state';
import { gitSnapshot } from './history';

export async function syncGit(project: WorkspaceProject, operation: 'fetch' | 'pull' | 'push', expected: string, signal: AbortSignal) {
  const inspect = async () => repositoryState(project, (await currentVersionState(project)).stateHash);
  let state = await inspect(); const root = project.rootDirectory;
  if (state.stateHash !== expected) throw new Error('工程状态已变化，请刷新 Git 状态后操作。');
  if (!state.remote) throw new Error(state.branch === 'HEAD' ? '当前为 detached HEAD，请先切换分支。' : state.remotes.length ? '请为当前分支配置跟踪远程仓库。' : '当前工程未配置远程仓库。');
  if (operation === 'pull' && state.changed.length) throw new Error('请先提交或处理工程中的未提交修改，再拉取远程仓库。');
  await fetchRemote(root, state.remote, signal); if (operation === 'fetch') return;
  state = await inspect(); signal.throwIfAborted();
  if (state.stateHash !== expected) throw new Error('同步期间工程状态已变化，源码和 HEAD 未修改，请刷新后重试。');
  const remote = state.remote!;
  if (operation === 'push') {
    if (!state.head) throw new Error('请先创建本地提交。');
    if (remote.behind > 0) throw new Error('远程包含本地没有的提交，请先拉取；分叉历史需在 Git 中解决。');
    assertRemoteUrl(remote, (await git(root, ['remote', 'get-url', '--push', remote.name])).trim());
    const protectedFiles = await git(root, ['log', '-1', '--format=%H', 'HEAD', '--', '.dreamedge/model.json', '.dreamedge/transaction']);
    if (protectedFiles.trim()) throw new Error('提交中包含模型配置或事务文件，拒绝推送；请先从 Git 移除私密文件。');
    await git(root, ['push', '--porcelain', remote.name, `${state.head}:refs/heads/${remote.branch}`], signal);
    await git(root, ['update-ref', remoteRef(remote), state.head]);
    await git(root, ['config', `branch.${state.branch}.remote`, remote.name]);
    await git(root, ['config', `branch.${state.branch}.merge`, `refs/heads/${remote.branch}`]); return;
  }
  if (!remote.exists) throw new Error('远程尚无对应分支，请先推送本地提交。');
  if (remote.ahead && remote.behind) throw new Error('本地和远程历史已分叉，请在 Git 中合并后重试；不会自动改写历史。');
  if (!remote.behind) return;
  const ref = remoteRef(remote); const target = (await git(root, ['rev-parse', ref])).trim();
  await gitSnapshot(project, target); // Validate source paths, identity and entry before checkout.
  const paths = (await git(root, ['diff', '--name-only', '-z', 'HEAD', target])).split('\0').filter(Boolean);
  if (paths.some(path => path.startsWith('.dreamedge/') && path !== '.dreamedge/project.json')) throw new Error('远程修改包含本机配置或私有工程文件，拒绝拉取。');
  // An ignored local file must never be overwritten by a remotely tracked file.
  const ignored = (await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  if (paths.some(path => ignored.includes(path) || ignored.some(local => local.startsWith(path + '/') || path.startsWith(local + '/')))) throw new Error('远程修改会覆盖本机忽略文件，拒绝拉取。');
  if ((await inspect()).stateHash !== expected) throw new Error('拉取准备期间工程已变化，请刷新后重试。');
  await git(root, ['merge', '--ff-only', '--no-autostash', target], signal);
  await git(root, ['branch', '--set-upstream-to', ref, state.branch], signal);
}
