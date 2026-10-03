import type { WorkspaceProject } from '../../shared/contracts';
import { commitId, git } from '../git/command';
import { gitHistory } from '../git/history';
import { projectGitStatus } from '../git/state';
import { currentVersionState } from '../changes/current';
import { assertProjectFile, projectFilePath, readProjectFile } from '../workspace/project-files';

export async function resolveHistoryCommit(project: WorkspaceProject, id: unknown): Promise<string> {
  const value = commitId(id);
  await git(project.rootDirectory, ['merge-base', '--is-ancestor', value, 'HEAD']); return value;
}
export async function readGit(project: WorkspaceProject, name: string, args: Record<string, unknown>) {
  if (name === 'git_status') {
    const status = await projectGitStatus(project, (await currentVersionState(project)).stateHash);
    return { head: status.head, branch: status.branch, changed: status.changed.filter(path => { try { projectFilePath(path); return true; } catch { return false; } }),
      changedCount: status.changed.length, remote: status.remote ? { name: status.remote.name, branch: status.remote.branch, ahead: status.remote.ahead, behind: status.remote.behind } : null };
  }
  if (name === 'git_log') return { commits: (await gitHistory(project.rootDirectory)).slice(0, args.limit as number) };
  const id = args.commitId === null ? null : await resolveHistoryCommit(project, args.commitId);
  if (!Array.isArray(args.paths) || args.paths.length > 20) throw new Error('Git 差异路径最多 20 个。');
  const changed = id ? (await git(project.rootDirectory, ['show', '--format=', '--name-only', '--diff-merges=first-parent', '--no-renames', '-z', id])).split('\0').map(path => path.trim()).filter(Boolean)
    : (await projectGitStatus(project, (await currentVersionState(project)).stateHash)).changed;
  const paths = args.paths.length ? args.paths as string[] : changed.filter(path => { try { projectFilePath(path); return true; } catch { return false; } }).slice(0, 20);
  const files: { path: string; diff: string }[] = []; let bytes = 0;
  for (const path of [...new Set(paths)]) {
    await assertProjectFile(project, path);
    let diff = await git(project.rootDirectory, id
      ? ['show', '--format=', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv', '--no-renames', id, '--', path]
      : ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--', path]);
    if (!diff && !id) { try { const text = await readProjectFile(project, path); diff = `New file ${path}\n` + text.split('\n').map(line => '+' + line).join('\n'); } catch { diff = '无可显示的文本差异。'; } }
    const remaining = Math.min(32768, 65536 - bytes); const raw = Buffer.from(diff);
    diff = raw.length > remaining ? raw.subarray(0, remaining).toString('utf8') + '\n…（差异已截断）' : diff;
    bytes += Buffer.byteLength(diff); files.push({ path, diff }); if (bytes >= 65536) break;
  }
  return { commitId: id, files, truncated: changed.length > paths.length || bytes >= 65536 };
}
