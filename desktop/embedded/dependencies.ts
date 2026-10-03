import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DependencyLock, WorkspaceProject } from '../../shared/contracts';
import { checkedPath, ensureDirectory, hash } from '../workspace/paths';
import { verifyArchive } from '../dependencies/registry';

export function archiveNames(lock?: DependencyLock): Map<string, string> {
  return new Map(Object.values(lock?.packages ?? {}).map(item => [hash(item.integrity) + '.tgz', item.integrity]));
}
async function readArchive(root: string, name: string, integrity: string): Promise<Buffer> {
  const file = await open(await checkedPath(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error('开发版依赖缓存无效或超过大小限制。');
    const bytes = await file.readFile(); verifyArchive(bytes, integrity); return bytes;
  } finally { await file.close(); }
}
export async function readLockedArchives(root: string, lock?: DependencyLock): Promise<Record<string, Buffer>> {
  const archives: Record<string, Buffer> = {}; let total = 0;
  for (const [name, integrity] of archiveNames(lock)) {
    const bytes = await readArchive(root, name, integrity); total += bytes.length;
    if (total > 128 * 1024 * 1024) throw new Error('开发版依赖缓存超过 128 MB。');
    archives[name] = bytes;
  }
  return archives;
}
export async function writeLockedArchives(root: string, lock: DependencyLock | undefined, archives: Record<string, Buffer> = {}): Promise<void> {
  let total = 0;
  for (const [name, integrity] of archiveNames(lock)) {
    const bytes = archives[name];
    if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024) throw new Error('开发版缺少有效的锁定依赖缓存。');
    verifyArchive(bytes, integrity); total += bytes.length;
    if (total > 128 * 1024 * 1024) throw new Error('开发版依赖缓存超过 128 MB。');
    await writeFile(join(root, name), bytes, { flag: 'wx', mode: 0o600 });
  }
}
export async function installLockedArchives(source: string, project: WorkspaceProject): Promise<void> {
  const names = archiveNames(project.definition.dependencyLock); if (!names.size) return;
  const cache = await ensureDirectory(project.buildDirectory, '.dependency-cache');
  for (const [name, integrity] of names) {
    try { await readArchive(cache, name, integrity); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const bytes = await readArchive(source, name, integrity);
    const temporary = join(cache, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, await checkedPath(cache, name));
    } finally { await rm(temporary, { force: true }); }
  }
}
