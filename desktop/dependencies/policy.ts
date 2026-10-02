import { valid, validRange, satisfies } from 'semver';
import type { DependencyLock, LockedPackage } from '../../shared/contracts';

export const REGISTRY = 'https://registry.npmjs.org' as const;
export function packageName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length > 180 || !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
    || name.split('/').some(part => ['node_modules', '__proto__', 'constructor', 'prototype'].includes(part))) throw new Error('依赖包名无效。');
}
export function dependencies(value: unknown, exact = true): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 20) throw new Error('最多支持 20 个直接依赖。');
  const result: Record<string, string> = Object.create(null);
  for (const [name, version] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    packageName(name);
    if (typeof version !== 'string' || version.length > 100 || !(exact ? valid(version) === version : validRange(version))) {
      throw new Error(exact ? '依赖需要准确版本，例如 19.2.0；不支持标签、范围、Git、URL 或本地路径。' : '传递依赖必须使用 npm 版本范围，不支持 Git、URL 或本地路径。');
    }
    result[name] = version;
  }
  return result;
}
export function registryUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('依赖下载地址无效。');
  const url = new URL(value);
  if (url.origin !== REGISTRY || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.tgz')) throw new Error('仅支持 npm 公共仓库的包归档。');
  return value;
}
export function validatePackage(value: unknown): LockedPackage {
  const item = value as LockedPackage;
  packageName(item?.name);
  if (valid(item.version) !== item.version || typeof item.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity)) throw new Error('依赖缺少有效版本或 SHA-512 完整性信息。');
  registryUrl(item.tarball); dependencies(item.dependencies, false); dependencies(item.peers, false);
  return item;
}
export function dependencyTarget(packages: Record<string, LockedPackage>, parent: string, name: string): string | null {
  let scope = parent;
  while (true) {
    const path = `${scope ? scope + '/' : ''}node_modules/${name}`;
    if (Object.hasOwn(packages, path)) return path;
    if (!scope) return null;
    const at = scope.lastIndexOf('/node_modules/'); scope = at < 0 ? '' : scope.slice(0, at);
  }
}
export function validateLock(value: unknown, declared: Record<string, string>): DependencyLock {
  const lock = value as DependencyLock;
  if (!lock || lock.schemaVersion !== 1 || lock.registry !== REGISTRY || !lock.packages || typeof lock.packages !== 'object'
    || Array.isArray(lock.packages) || Object.keys(lock.packages).length > 100 || JSON.stringify(dependencies(lock.dependencies)) !== JSON.stringify(dependencies(declared))) throw new Error('依赖锁定记录与工程声明不一致。');
  for (const [path, item] of Object.entries(lock.packages)) {
    if (path.length > 1500 || !/^(node_modules\/(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(\/node_modules\/(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/.test(path)) throw new Error('依赖安装路径无效。');
    validatePackage(item);
    if (!path.endsWith(`node_modules/${item.name}`)) throw new Error('依赖身份与路径不一致。');
    for (const [name, range] of [...Object.entries(item.dependencies), ...Object.entries(item.peers)]) {
      const target = dependencyTarget(lock.packages, path, name);
      if (!target || !satisfies(lock.packages[target].version, range)) throw new Error(`依赖版本冲突或缺失：${item.name} → ${name} ${range}`);
    }
  }
  for (const [name, version] of Object.entries(declared)) if (lock.packages[`node_modules/${name}`]?.version !== version) throw new Error('直接依赖缺少准确锁定版本。');
  return lock;
}
