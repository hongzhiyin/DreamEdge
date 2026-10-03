import type { GitCommit, WorkspaceProject } from '../../shared/contracts';
import { hash } from '../workspace/paths';
import { git, MANAGED } from './command';
import { gitStatus } from './repository';
import { gitHistory } from './history';
import { remoteRef, remoteStatus } from './remote';

export async function repositoryState(project: WorkspaceProject, sourceHash: string) {
  const root = project.rootDirectory; const base = await gitStatus(root);
  const all = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']);
  const otherChanged: string[] = [];
  const entries = all.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const path = entries[i].slice(3);
    if (!MANAGED.some(name => path === name || path.startsWith(name + '/'))) otherChanged.push(path);
    if (/[RC]/.test(entries[i].slice(0, 2))) i++;
  }
  const metadata = await remoteStatus(root, base.branch, base.head);
  const fingerprint = await git(root, ['diff', '--binary', 'HEAD', '--', ...MANAGED]).catch(() => '');
  const index = await git(root, ['ls-files', '--stage', '-z']);
  const config = await git(root, ['config', '--get-regexp', '^(remote\.|branch\.)']).catch(() => '');
  const stateHash = hash(JSON.stringify([sourceHash, base.head, base.branch, all, fingerprint, index, config]));
  return { ...base, otherChanged, stateHash, ...metadata };
}
export async function projectGitStatus(project: WorkspaceProject, sourceHash: string) {
  const state = await repositoryState(project, sourceHash); const commits: GitCommit[] = await gitHistory(project.rootDirectory);
  const remoteCommits: GitCommit[] = [];
  if (state.remote?.exists && state.head) {
    const ref = remoteRef(state.remote);
    const local = new Set((await git(project.rootDirectory, ['rev-list', `HEAD`, '--not', ref])).trim().split('\n'));
    for (const commit of commits) commit.remoteState = local.has(commit.id) ? 'local' : 'pushed';
    const history = await git(project.rootDirectory, ['log', '-50', '--date-order', '--format=%H%x00%s%x00%cI', `HEAD..${ref}`]);
    for (const line of history.trim().split('\n').filter(Boolean)) { const [id, message, createdAt] = line.split('\0'); remoteCommits.push({ id, message, createdAt }); }
  } else for (const commit of commits) commit.remoteState = state.remote ? 'unknown' : 'local';
  return { ...state, commits, remoteCommits };
}
