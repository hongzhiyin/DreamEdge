import { createHash, randomUUID } from 'node:crypto';
import { open, rename, rm, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, posix } from 'node:path';
import { Unpack } from 'tar';
import type { LockedPackage } from '../../shared/contracts';
import { checkedPath, directory, ensureDirectory, relativeParts } from '../workspace/paths';
import { verifyArchive, type PackageRegistry } from './registry';

export async function cachedArchive(cache: string, item: LockedPackage, registry: PackageRegistry, signal: AbortSignal): Promise<Buffer> {
  const name = createHash('sha256').update(item.integrity).digest('hex') + '.tgz';
  const target = await checkedPath(cache, name);
  try {
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error('依赖缓存无效。');
      const bytes = await handle.readFile(); verifyArchive(bytes, item.integrity); return bytes;
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  signal.throwIfAborted(); const bytes = await registry.download(item, signal); verifyArchive(bytes, item.integrity);
  let cached = 0;
  for (const file of await readdir(cache)) if (!file.startsWith('.')) {
    const stat = await lstat(await checkedPath(cache, file)); cached += stat.size;
  }
  if (cached + bytes.length > 128 * 1024 * 1024) throw new Error('工程依赖缓存超过 128 MB，请清理后重试。');
  const temporary = join(cache, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    signal.throwIfAborted(); await handle.writeFile(bytes); await handle.sync(); await handle.close();
    await checkedPath(cache, name); await rename(temporary, target);
  } finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
  return bytes;
}
export async function unpackArchive(bytes: Buffer, root: string, signal: AbortSignal): Promise<void> {
  await directory(root); signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let total = 0; let count = 0; let prefix: string | undefined; const seen = new Set<string>();
    const unpack = new Unpack({ cwd: root, strip: 1, strict: true, maxDepth: 40, chmod: false,
      filter(path, candidate) {
        const entry = candidate as import('tar').ReadEntry;
        try {
          signal.throwIfAborted();
          const name = path.replace(/\/$/, ''); const parts = relativeParts(name);
          prefix ??= parts[0];
          if (parts[0] !== prefix || !['File', 'Directory'].includes(entry.type) || parts.length === 1 && entry.type !== 'Directory') throw new Error('依赖归档包含链接或无效路径。');
          if (parts.slice(1).includes('node_modules') || seen.has(name)) throw new Error('依赖归档包含嵌套安装目录或重复路径。');
          seen.add(name); total += entry.size; count++;
          if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 4 * 1024 * 1024 || total > 64 * 1024 * 1024 || count > 3000) throw new Error('依赖解包超过文件数量或大小限制。');
          return true;
        } catch (error) { unpack.abort(error as Error); return false; }
      } });
    const abort = () => unpack.abort(new Error('依赖安装已停止。'));
    signal.addEventListener('abort', abort, { once: true });
    const finish = (error?: Error) => { signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
    unpack.once('error', finish); unpack.once('close', () => finish());
    unpack.end(bytes); if (signal.aborted) abort();
  });
}
export async function dependencyFiles(root: string, signal: AbortSignal): Promise<Record<string, string>> {
  const files: Record<string, string> = Object.create(null); let bytes = 0; let count = 0;
  async function visit(path: string): Promise<void> {
    const folder = await directory(path ? join(root, path) : root);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      signal.throwIfAborted(); const name = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await visit(name); continue; }
      const target = await checkedPath(root, name); count++;
      if (count > 10000) throw new Error('安装依赖文件过多。');
      if (!['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.css', '.svg', '.txt'].includes(posix.extname(name))) continue;
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat(); bytes += stat.size;
        if (stat.size > 4 * 1024 * 1024 || bytes > 24 * 1024 * 1024) throw new Error('依赖源码超过构建输入限制。');
        files[name] = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
      } finally { await handle.close(); }
    }
  }
  await visit(''); return files;
}
