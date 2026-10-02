import type { WorkspaceFile } from '../../shared/contracts';
import { hash, listSource, readText, writeText } from './paths';
import { WorkspaceManager } from './manager';

export class WorkspaceFiles {
  constructor(private readonly manager: WorkspaceManager) {}
  async list(projectId: unknown): Promise<string[]> {
    return listSource((await this.manager.project(projectId)).sourceDirectory);
  }
  async read(projectId: unknown, path: string): Promise<WorkspaceFile> {
    const root = (await this.manager.project(projectId)).sourceDirectory;
    const content = await readText(root, path);
    return { path, content, hash: hash(content) };
  }
  async write(projectId: unknown, path: string, content: string, expectedHash: string | null): Promise<WorkspaceFile> {
    const root = (await this.manager.project(projectId)).sourceDirectory;
    if (typeof expectedHash !== 'string' && expectedHash !== null) throw new Error('写入必须提供读取时的文件校验值。');
    let actual: string | null = null;
    try { actual = hash(await readText(root, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (actual !== expectedHash) throw new Error('文件已发生变化，请重新读取后再保存。');
    await writeText(root, path, content);
    return { path, content, hash: hash(content) };
  }
}
