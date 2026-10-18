import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileScopeService } from './scope-service.js';
import type { FileAccessBinding } from './scope-types.js';
import { sameIdentity, fileIdentity } from './scope-paths.js';
import { FileScopeError } from './scope-types.js';

/** Names come from a checked directory; every selected child receives its own policy binding. */
export async function listScopedDirectory(scopes: FileScopeService, binding: FileAccessBinding,
  signal: AbortSignal, maximum: number): Promise<string[]> {
  signal.throwIfAborted(); const initial = await scopes.verify(binding);
  if (!initial.stat?.isDirectory()) throw new FileScopeError('FILE_SCOPE_DENIED', '列表与递归查找需要目录。');
  const handle = await open(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || !sameIdentity(fileIdentity(initial.stat), fileIdentity(stat))) changed();
    await scopes.verify(binding); signal.throwIfAborted();
    const directory = await opendir(binding.path); const names: string[] = [];
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (names.length >= maximum) throw new FileScopeError('FILE_TOO_LARGE', '目录项目数超过扫描上限。');
      names.push(entry.name);
    }
    const final = await scopes.verify(binding); signal.throwIfAborted();
    if (!final.stat || !sameIdentity(fileIdentity(stat), fileIdentity(final.stat))
      || stat.mtimeNs !== final.stat.mtimeNs || stat.ctimeNs !== final.stat.ctimeNs) changed();
    return names.sort().map(name => join(binding.path, name));
  } finally { await handle.close(); }
}
function changed(): never { throw new FileScopeError('FILE_CHANGED', '目录身份或内容已变化，请重新查找。'); }
