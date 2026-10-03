import type { GitCommit, WorkspaceProject } from '../../shared/contracts';
import { hash } from '../workspace/paths';
import { git } from './command';
import { gitStatus } from './repository';
import { gitHistory } from './history';
import { remoteRef, remoteStatus } from './remote';
import { changedFilesFingerprint } from './fingerprint';

export async function repositoryState(project: WorkspaceProject, sourceHash: string) {
  const root = project.rootDirectory; const { porcelain, ...base } = await gitStatus(root);
  const metadata = await remoteStatus(root, base.branch, base.head);
  const fingerprint = await changedFilesFingerprint(root, base.changed);
  const index = await git(root, ['ls-files', '--stage', '-z']);
  const config = await git(root, ['config', '--get-regexp', '^(remote\.|branch\.)']).catch(() => '');
  const stateHash = hash(JSON.stringify([sourceHash, base.head, base.branch, porcelain, fingerprint, index, config]));
  return { ...base, stateHash, ...metadata };
}
export async function projectGitStatus(project: WorkspaceProject, sourceHash: string) {
  const state = await repositoryState(project, sourceHash); const commits: GitCommit[] = await gitHistory(project.rootDirectory);
  const remoteCommits: GitCommit[] = [];
  if (state.remote?.exists && state.head) {
    const ref = remoteRef(state.remote);
    const local = new Set((await git(project.rootDirectory, ['rev-list', `HEAD`, '--not', ref])).trim().split('\n'));
    for (const commit of commits) commit.remoteState = local.has(commit.id) ? 'local' : 'pushed';
    remoteCommits.push(...await gitHistory(project.rootDirectory, `HEAD..${ref}`));
  } else for (const commit of commits) commit.remoteState = state.remote ? 'unknown' : 'local';
  return { ...state, commits, remoteCommits };
}
