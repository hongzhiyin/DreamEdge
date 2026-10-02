import { posix } from 'node:path';
import type { DependencyLock } from '../../shared/contracts';
import { dependencies, dependencyTarget, packageName, validateLock } from '../dependencies/policy';
import { relativeParts } from '../workspace/paths';

function condition(value: unknown, kind: string): string | null {
  if (typeof value === 'string') return value;
  if (value === null || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) { for (const entry of value) { const found = condition(entry, kind); if (found) return found; } return null; }
  for (const [key, entry] of Object.entries(value)) if (['browser', kind === 'require-call' ? 'require' : 'import', 'default'].includes(key)) {
    const found = condition(entry, kind); if (found) return found;
  }
  return null;
}
export class DependencyModules {
  constructor(readonly files: Record<string, string>, readonly lock: DependencyLock) {
    validateLock(lock, dependencies(lock.dependencies));
    for (const path of Object.keys(files)) { relativeParts(path); if (!path.startsWith('node_modules/')) throw new Error('依赖源码路径无效。'); }
  }
  file(path: string): string {
    relativeParts(path);
    const found = [path, ...['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.css', '/index.js', '/index.mjs', '/index.ts'].map(suffix => path + suffix)]
      .find(value => Object.hasOwn(this.files, value));
    if (!found) throw new Error(`依赖文件不存在或类型不受支持：${path}`);
    return found;
  }
  private owner(importer: string): string {
    return Object.keys(this.lock.packages).filter(path => importer.startsWith(path + '/')).sort((a, b) => b.length - a.length)[0] ?? '';
  }
  resolve(specifier: string, importer: string, kind: string): string {
    if (specifier.includes(':') || specifier.includes('\\') || specifier.includes('?') || specifier.includes('#') || specifier.startsWith('/')) throw new Error('禁止远程、Node.js 或绝对路径导入。');
    const owner = this.owner(importer);
    const manifest = owner ? JSON.parse(this.files[`${owner}/package.json`]) : null;
    const mapped = manifest?.browser && typeof manifest.browser === 'object' ? manifest.browser[specifier] : undefined;
    if (mapped === false) return '__empty__';
    if (typeof mapped === 'string') specifier = mapped;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const path = posix.normalize(posix.join(mapped === undefined ? posix.dirname(importer) : owner, specifier));
      return this.file(path);
    }
    const parts = specifier.split('/'); const name = parts[0].startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()!;
    packageName(name); if (parts.length) relativeParts(parts.join('/'));
    if (!owner && !Object.hasOwn(this.lock.dependencies, name)) throw new Error(`工程未声明依赖：${name}`);
    if (owner && name !== this.lock.packages[owner].name && !Object.hasOwn(this.lock.packages[owner].dependencies, name)
      && !Object.hasOwn(this.lock.packages[owner].peers, name)) throw new Error(`包未声明依赖：${name}`);
    const target = dependencyTarget(this.lock.packages, owner, name);
    if (!target) throw new Error(`缺少锁定依赖：${name}`);
    const metadata = JSON.parse(this.files[`${target}/package.json`]);
    const subpath = parts.length ? './' + parts.join('/') : '.';
    let entry: string | null;
    if (metadata.exports !== undefined) {
      const map = metadata.exports;
      const value = typeof map === 'object' && map !== null && !Array.isArray(map) && Object.keys(map).some(key => key.startsWith('.')) ? map[subpath] : subpath === '.' ? map : null;
      entry = condition(value, kind);
      if (!entry) throw new Error(`依赖未导出浏览器入口：${specifier}`);
    } else entry = parts.length ? './' + parts.join('/') : typeof metadata.browser === 'string' ? metadata.browser : metadata.module ?? metadata.main ?? './index.js';
    if (typeof entry !== 'string') throw new Error('依赖入口无效。');
    const relative = entry.replace(/^\.\//, ''); relativeParts(relative);
    return this.file(`${target}/${relative}`);
  }
}
