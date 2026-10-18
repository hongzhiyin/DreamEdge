import { homedir } from 'node:os';
import { parse } from 'node:path';
import { realpath } from 'node:fs/promises';
import { inspectRoot } from './scope-paths.js';
import { FileScopeError } from './scope-types.js';
import type { DeviceAccessPolicy } from './scope-types.js';
import { freezeDeep } from '../tools/json.js';

/** Account access is host policy; neither old directory grants nor renderer input enable it. */
export async function accountFileAccess(base = homedir(), protectedPaths: readonly string[] = []): Promise<DeviceAccessPolicy> {
  const baseDirectory = await realpath(base);
  const candidates = process.platform === 'win32'
    ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
    : [parse(baseDirectory).root];
  const results = await Promise.allSettled(candidates.map(path => inspectRoot(path)));
  const roots = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  if (!roots.length) throw new FileScopeError('FILE_SCOPE_INVALID', '无法确定账户可访问的文件系统。');
  const protectedWritePaths = await Promise.all(protectedPaths.map(path => realpath(path)));
  return freezeDeep({ mode: 'account', baseDirectory, roots, protectedWritePaths });
}
