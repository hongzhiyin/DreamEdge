import { hash, listSource, readText, relativeParts, writeText } from './paths';

export interface SourceTree { files: Record<string, string>; hashes: Record<string, string> }
export function treeHashes(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(files).sort().map(path => [path, hash(files[path])]));
}
export function equalHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  const sorted = (input: Record<string, string>) => Object.entries(input).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}
export function validHashes(input: unknown, limit = 200): input is Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > limit) return false;
  try { return Object.entries(input).every(([path, value]) => {
    relativeParts(path); return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }); } catch { return false; }
}
export async function readSourceTree(root: string): Promise<SourceTree> {
  const paths = await listSource(root);
  if (paths.length > 200) throw new Error('当前源码快照最多支持 200 个文件。');
  const files: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const path of paths) {
    const content = await readText(root, path);
    bytes += Buffer.byteLength(content);
    if (bytes > 4 * 1024 * 1024) throw new Error('源码快照总量不能超过 4 MB。');
    files[path] = content;
  }
  return { files, hashes: treeHashes(files) };
}
export async function writeSourceTree(root: string, files: Record<string, string>, signal?: AbortSignal): Promise<void> {
  for (const [path, content] of Object.entries(files)) { signal?.throwIfAborted(); await writeText(root, path, content); }
}
export function stateHash(definitionHash: string, hashes: Record<string, string>): string {
  return hash(JSON.stringify([definitionHash, Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))]));
}
