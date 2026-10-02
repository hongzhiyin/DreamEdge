import { lstat, mkdir, open, realpath, readdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const TEXT_LIMIT = 1024 * 1024;
export function inside(root: string, target: string): boolean {
  const part = relative(root, target);
  return part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part);
}
export function relativeParts(value: unknown): string[] {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\\\x00:]/.test(value) || isAbsolute(value)) throw new Error('源码路径必须是有效的相对路径。');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('禁止源码路径越界。');
  return parts;
}
export async function directory(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('工程目录不能是文件或符号链接。');
  return realpath(path);
}
export async function checkedPath(root: string, name: string, createParents = false): Promise<string> {
  const parts = relativeParts(name);
  await directory(root);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (createParents) await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await directory(current);
  }
  const target = join(current, parts.at(-1)!);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('源码文件不能是目录、符号链接或硬链接。');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return target;
}
export async function ensureDirectory(root: string, name: string): Promise<string> {
  let current = await directory(root);
  for (const part of relativeParts(name)) {
    current = join(current, part);
    await mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await directory(current);
  }
  return current;
}
export function hash(content: string): string { return createHash('sha256').update(content).digest('hex'); }
export async function readText(root: string, name: string): Promise<string> {
  const filename = await checkedPath(root, name);
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > TEXT_LIMIT) throw new Error('仅支持不超过 1 MB 的普通文本文件。');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile());
    if (content.includes('\0')) throw new Error('仅支持 UTF-8 文本文件。');
    return content;
  } finally { await handle.close(); }
}
export async function writeText(root: string, name: string, content: string): Promise<void> {
  if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > TEXT_LIMIT) throw new Error('仅支持不超过 1 MB 的文本内容。');
  const target = await checkedPath(root, name, true);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    await checkedPath(root, name);
    await rename(temporary, target);
  } finally { await handle.close().catch(() => {}); await rm(temporary, { force: true }); }
}
export async function listSource(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(folder: string, prefix: string, depth: number): Promise<void> {
    if (depth > 40) throw new Error('源码目录层级过深。');
    await directory(folder);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('源码目录包含符号链接。');
      if (entry.isDirectory()) await walk(join(folder, entry.name), name, depth + 1);
      else {
        await checkedPath(root, name);
        result.push(name);
        if (result.length > 1000) throw new Error('当前阶段最多支持 1000 个源码文件。');
      }
    }
  }
  await walk(root, '', 0);
  return result.sort();
}
export async function canonicalTarget(value: unknown, mustExist: boolean): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.length > 4096) throw new Error('工程目录必须是绝对路径。');
  const path = resolve(value);
  return mustExist ? directory(path) : join(await directory(dirname(path)), basename(path));
}
