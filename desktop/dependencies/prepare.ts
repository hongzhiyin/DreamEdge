import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DependencyLock, WorkspaceProject } from '../../shared/contracts';
import { ensureDirectory } from '../workspace/paths';
import { dependencies, validateLock } from './policy';
import { NpmRegistry, type PackageRegistry } from './registry';
import { resolveLock } from './resolve';
import { cachedArchive, dependencyFiles, unpackArchive } from './archive';

export interface PreparedDependencies { lock: DependencyLock; files: Record<string, string> }
export type DependencyPreparer = (project: WorkspaceProject, root: string, declared: Record<string, string>, signal: AbortSignal,
  report: (message: string) => Promise<void>) => Promise<PreparedDependencies>;
export function dependencyPreparer(registry: PackageRegistry = new NpmRegistry()): DependencyPreparer {
  return async (project, root, input, signal, report) => {
    const declared = dependencies(input);
    const saved = project.definition.dependencyLock;
    const lock = saved && JSON.stringify(dependencies(saved.dependencies)) === JSON.stringify(declared)
      ? structuredClone(validateLock(saved, declared)) : await resolveLock(declared, registry, signal, report);
    if (!Object.keys(lock.packages).length) return { lock, files: {} };
    const staging = await ensureDirectory(root, 'dependencies');
    const cache = await ensureDirectory(project.buildDirectory, '.dependency-cache');
    try {
      for (const [path, item] of Object.entries(lock.packages)) {
        signal.throwIfAborted(); await report(`安装依赖 ${item.name}@${item.version}`);
        const bytes = await cachedArchive(cache, item, registry, signal);
        signal.throwIfAborted();
        await unpackArchive(bytes, await ensureDirectory(staging, path), signal);
      }
      const files = await dependencyFiles(staging, signal);
      for (const [path, item] of Object.entries(lock.packages)) {
        const manifest = JSON.parse(files[`${path}/package.json`] ?? 'null');
        if (manifest?.name !== item.name || manifest?.version !== item.version) throw new Error('安装包身份与锁定记录不一致。');
      }
      await report(`已校验 ${Object.keys(lock.packages).length} 个锁定依赖，未执行安装脚本。`);
      return { lock, files };
    } finally { await rm(join(root, 'dependencies'), { recursive: true, force: true }); }
  };
}
