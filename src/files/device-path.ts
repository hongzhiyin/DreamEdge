import { resolve } from 'node:path';
import { dshFileBackend } from './dsh-backend.js';
import { excluded } from './scope-paths.js';
import { FileScopeError } from './scope-types.js';
import type { FileScopeGrant } from './scope-types.js';

/** Reuse DSH canonical target resolution; the scoped IO gates still check the resolved target. */
export async function devicePath(roots: readonly FileScopeGrant[], input: string): Promise<string> {
  const baseDirectory = roots.find(root => root.device)?.device?.baseDirectory;
  if (!baseDirectory || typeof input !== 'string' || !input || input.includes('\0') || input.startsWith('@')) {
    throw new FileScopeError('FILE_SCOPE_INVALID', '整机文件路径无效。');
  }
  const expanded = input === '~' || input.startsWith('~/') ? resolve(baseDirectory, input.slice(2) || '.') : input;
  const display = resolve(baseDirectory, expanded);
  if (roots.some(root => excluded(root, display))) throw new FileScopeError('FILE_SCOPE_DENIED', '敏感文件仍被排除，不能读取或修改。');
  const backend = dshFileBackend();
  try { return (await backend.filesystem.resolve(expanded, { cwd: baseDirectory })).targetKey; }
  finally { await backend.dispose(); }
}
