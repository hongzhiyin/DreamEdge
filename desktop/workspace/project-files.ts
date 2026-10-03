import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceProject } from '../../shared/contracts';
import { git } from '../git/command';
import { readText, relativeParts } from './paths';

export function projectFilePath(value: unknown): string {
  const parts = relativeParts(value); const name = parts.at(-1)!;
  if (parts.some(part => ['.git', '.dreamedge', 'node_modules', '.ssh'].includes(part))
      || /^(\.env(?:\..*)?|\.npmrc|\.netrc|credentials\.json|id_rsa|id_ed25519)$/i.test(name)
      || /\.(pem|key)$/i.test(name)) throw new Error('此路径属于工程私有配置、凭据或内部目录，不能发送给模型或由 AI 修改。');
  return parts.join('/');
}
export async function assertProjectFile(project: WorkspaceProject, path: string): Promise<void> {
  projectFilePath(path);
  if ((await git(project.rootDirectory, ['check-ignore', '--no-index', '--', path])).trim()) throw new Error('该文件被 Git 忽略，不能进入 AI 上下文或候选修改。');
}
export async function readProjectFile(project: WorkspaceProject, path: string): Promise<string> {
  await assertProjectFile(project, path); return readText(project.rootDirectory, path);
}
export async function listProjectFiles(project: WorkspaceProject): Promise<string[]> {
  const entries = (await git(project.rootDirectory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const ignored = new Set((await git(project.rootDirectory, ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean));
  const files: string[] = [];
  for (const path of [...new Set(entries)].sort()) {
    if (ignored.has(path)) continue;
    try { projectFilePath(path); } catch { continue; }
    try { if ((await lstat(join(project.rootDirectory, path))).isFile()) files.push(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return files;
}
