import { satisfies } from 'semver';
import type { DependencyLock, LockedPackage } from '../../shared/contracts';
import { REGISTRY, dependencies, dependencyTarget, validateLock, validatePackage } from './policy';
import type { PackageRegistry } from './registry';

export async function resolveLock(input: Record<string, string>, registry: PackageRegistry, signal: AbortSignal,
  report: (message: string) => Promise<void>): Promise<DependencyLock> {
  const declared = dependencies(input); const packages: Record<string, LockedPackage> = Object.create(null);
  const cache = new Map<string, LockedPackage>();
  async function resolve(name: string, range: string) {
    signal.throwIfAborted(); const key = `${name}@${range}`;
    if (!cache.has(key)) { await report(`解析依赖 ${key}`); cache.set(key, validatePackage(await registry.resolve(name, range, signal))); }
    return structuredClone(cache.get(key)!);
  }
  for (const [name, version] of Object.entries(declared)) packages[`node_modules/${name}`] = await resolve(name, version);
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > 12 || Object.keys(packages).length > 100) throw new Error('依赖树超过 100 个包或层级限制。');
    for (const [name, range] of Object.entries(packages[path].dependencies)) {
      const found = dependencyTarget(packages, path, name);
      if (found && satisfies(packages[found].version, range)) continue;
      const next = `${path}/node_modules/${name}`;
      packages[next] = await resolve(name, range); await visit(next, depth + 1);
    }
  }
  for (const name of Object.keys(declared)) await visit(`node_modules/${name}`, 0);
  return validateLock({ schemaVersion: 1, registry: REGISTRY, dependencies: declared, packages }, declared);
}
