import type { ModelProposal, ProjectContext, WorkspaceProject } from '../../shared/contracts';
import { git } from '../git/command';
import { gitSnapshot } from '../git/history';
import { hash } from '../workspace/paths';
import { assertProjectFile, listProjectFiles, projectFilePath, readProjectFile } from '../workspace/project-files';
import { CONTEXT_FILES, CONTEXT_LIMIT, PROPOSAL_LIMIT } from './context';
import { resolveHistoryCommit } from './git-read';

export interface RestorePlan { commitId: string; files: ModelProposal['files']; dependencies?: Record<string, string> }
export async function restorePlan(project: WorkspaceProject, context: ProjectContext, id: unknown, input: unknown,
  guard: (value: unknown) => void): Promise<RestorePlan> {
  const commitId = await resolveHistoryCommit(project, id); const snapshot = await gitSnapshot(project, commitId);
  if (!Array.isArray(input) || input.length > 20) throw new Error('恢复路径最多 20 个。');
  const tree = (await git(project.rootDirectory, ['ls-tree', '-r', '-z', commitId])).split('\0').filter(Boolean);
  const objects = new Map<string, string>();
  for (const entry of tree) {
    const [metadata, path] = entry.split('\t'); const [mode, type, object] = metadata.split(' ');
    try { projectFilePath(path); } catch { continue; }
    if (!['100644', '100755'].includes(mode) || type !== 'blob') continue;
    objects.set(path, object);
  }
  const all = !input.length; const paths = all ? [...new Set([...objects.keys(), ...await listProjectFiles(project)])] : input as string[];
  const files: RestorePlan['files'] = []; let bytes = 0;
  for (const path of paths) {
    try { await assertProjectFile(project, path); } catch (error) { if (all && error instanceof Error && /被 Git 忽略|私有配置/.test(error.message)) continue; throw error; }
    let before: string | null = null;
    try { before = await readProjectFile(project, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const after = objects.has(path) ? await git(project.rootDirectory, ['cat-file', 'blob', objects.get(path)!]) : null;
    if (after?.includes('\0')) throw new Error('AI 历史恢复当前只支持普通 UTF-8 文件，请指定需要恢复的文本路径。');
    if (before === after) continue;
    guard({ path, before, after });
    const previous = context.files.find(file => file.path === path);
    if (previous && before !== previous.content) throw new Error('工程文件已变化，请重新请求恢复。');
    if (before !== null && !previous) context.files.push({ path, content: before, hash: hash(before) });
    files.push({ path, content: after }); bytes += Buffer.byteLength(after ?? '');
  }
  if (files.length > 20 || bytes > PROPOSAL_LIMIT || context.files.length > CONTEXT_FILES
    || context.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > CONTEXT_LIMIT) throw new Error('恢复内容超过当前候选限额，请指定较小的路径范围。');
  return { commitId, files, dependencies: all ? snapshot.definition.dependencies : undefined };
}
