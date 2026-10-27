import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BigIntStats } from 'node:fs';
import { FileScopeError } from './scope-types.js';
import type { FileIdentity, FileScopeGrant } from './scope-types.js';

export const fileIdentity = (stat: BigIntStats): FileIdentity => ({ device: String(stat.dev), inode: String(stat.ino) });
export const sameIdentity = (a: FileIdentity, b: FileIdentity) => a.device === b.device && a.inode === b.inode;
export const containsPath = (root: string, path: string) => {
  const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
};
const denied = () => new FileScopeError('FILE_SCOPE_DENIED', '路径不在授权范围内，或无法确认文件身份。');
/** Reject Win32 aliases/devices/streams before resolution can conceal their spelling. */
export function checkPathSpelling(input: string): void {
  if (process.platform !== 'win32') return;
  if (/^[\\/]{2}[?.][\\/]/.test(input) || /^[a-z]:(?![\\/])/i.test(input)) throw denied();
  const parts = input.replace(/^[a-z]:/i, '').split(/[\\/]/);
  if (parts.some(part => /[<>:"|?*\x00-\x1f]/.test(part)
    || (part !== '.' && part !== '..' && /[. ]$/.test(part))
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw denied();
}
export function excluded(grant: FileScopeGrant, path: string): boolean {
  const fold = (value: string) => value.normalize('NFC').toLowerCase();
  const part = fold(relative(grant.path, path)); const components = path.split(sep).map(fold);
  if (components.some(p => ['.git', '.ssh', '.codex'].includes(p) || p === '.env' || p.startsWith('.env.')
    || p === 'file-access.local.json'
    || /^credentials(?:\.|$)/i.test(p))) return true;
  if (grant.device && components.some(p => ['.aws', '.azure', '.kube', '.gnupg', 'keychains', '.npmrc', '.pypirc'].includes(p))) return true;
  return grant.excludes.some(value => { const prefix = fold(value); return part === prefix || part.startsWith(`${prefix}${sep}`); });
}
export async function inspectRoot(selected: string): Promise<{ path: string; identity: FileIdentity }> {
  if (typeof selected !== 'string' || !isAbsolute(selected) || selected.includes('\0')) throw denied();
  const path = await realpath(selected); const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw denied();
  return { path, identity: fileIdentity(stat) };
}
export async function checkRoot(grant: FileScopeGrant): Promise<void> {
  const stat = await lstat(grant.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(grant.path) !== grant.path
    || !sameIdentity(grant.identity, fileIdentity(stat))) throw denied();
}
/** Preflight and each actual IO gate reject links. This is not a kernel sandbox. */
export async function inspectPath(grant: FileScopeGrant, input: string, allowMissing = false) {
  if (typeof input !== 'string' || !input || input.includes('\0') || (sep !== '\\' && input.includes('\\'))
    || input.split(sep === '\\' ? /[\\/]/ : '/').includes('..') || input.startsWith('~') || input.startsWith('@')) throw denied();
  checkPathSpelling(input);
  const path = resolve(grant.path, input);
  if (!containsPath(grant.path, path) || excluded(grant, path)) throw denied();
  await checkRoot(grant);
  const parts = relative(grant.path, path).split(sep).filter(Boolean); let current = grant.path;
  let target: BigIntStats | undefined;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try { target = await lstat(current, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing && index === parts.length - 1) return { path };
      throw error;
    }
    if (target.isSymbolicLink() || (index < parts.length - 1 && !target.isDirectory())
      || (!target.isDirectory() && (!target.isFile() || target.nlink !== 1n))) throw denied();
  }
  await checkRoot(grant);
  return { path, stat: target ?? await lstat(grant.path, { bigint: true }) };
}
