import { rm } from 'node:fs/promises';
import type { CandidateFile, WorkspaceProject } from '../../shared/contracts';
import { assertProjectFile, projectFilePath } from '../workspace/project-files';
import { checkedPath, hash, readText, writeText } from '../workspace/paths';

export interface ProjectFileEdit { path: string; before: string | null; after: string | null }
export async function fileOrNull(root: string, path: string): Promise<string | null> {
  try { return await readText(root, path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export async function assertProjectChanges(project: WorkspaceProject, changes: CandidateFile[] = []): Promise<void> {
  for (const change of changes) {
    await assertProjectFile(project, change.path);
    const content = await fileOrNull(project.rootDirectory, change.path);
    if ((content === null ? null : hash(content)) !== change.expectedHash) throw new Error('工程文件已变化，拒绝覆盖当前修改。');
  }
}
export async function prepareProjectChanges(project: WorkspaceProject, changes: CandidateFile[]): Promise<ProjectFileEdit[]> {
  await assertProjectChanges(project, changes);
  return Promise.all(changes.map(async change => ({ path: change.path, before: await fileOrNull(project.rootDirectory, change.path), after: change.content })));
}
export async function assertProjectContext(project: WorkspaceProject, hashes: Record<string, string> = {}) {
  for (const [path, expected] of Object.entries(hashes)) if (hash(await readText(project.rootDirectory, projectFilePath(path))) !== expected) throw new Error('工程上下文文件已变化，请重新生成修改。');
}
export function validateProjectEdits(edits: unknown): asserts edits is ProjectFileEdit[] | undefined {
  if (edits === undefined) return;
  if (!Array.isArray(edits) || edits.length > 20 || new Set(edits.map(edit => edit?.path)).size !== edits.length) throw new Error('工程文件事务记录无效。');
  let bytes = 0;
  for (const edit of edits) {
    projectFilePath(edit.path);
    if (edit.path === 'src' || edit.path.startsWith('src/')) throw new Error('工程文件事务不能重复包含源码目录。');
    for (const value of [edit.before, edit.after]) {
      if (value !== null && (typeof value !== 'string' || value.includes('\0'))) throw new Error('工程文件事务内容无效。');
      bytes += Buffer.byteLength(value ?? '');
    }
  }
  if (bytes > 256 * 1024) throw new Error('工程文件事务内容过大。');
}
export async function verifyProjectEdits(root: string, edits: ProjectFileEdit[] = [], phase: 'before' | 'either' | 'after' = 'either') {
  for (const edit of edits) {
    const value = await fileOrNull(root, edit.path);
    if (!(phase === 'either' ? [edit.before, edit.after] : [edit[phase]]).includes(value)) throw new Error('工程文件在保存或恢复期间被外部修改，事务备份已保留。');
  }
}
export async function installProjectEdits(root: string, edits: ProjectFileEdit[] = [], side: 'before' | 'after') {
  await verifyProjectEdits(root, edits);
  for (const edit of edits) {
    const value = edit[side];
    if (value === null) await rm(await checkedPath(root, edit.path), { force: true }); else await writeText(root, edit.path, value);
  }
}
