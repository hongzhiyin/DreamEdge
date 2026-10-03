import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, join } from 'node:path';
import type { AppManifest } from '../shared/contracts';
export function containedPath(root: string, name: string): string {
  if (isAbsolute(name)) throw new Error('项目资源必须使用相对路径。');
  const filename = resolve(root, name);
  const within = relative(root, filename);
  if (within === '..' || within.startsWith('../') || within.startsWith('..\\') || isAbsolute(within)) {
    throw new Error('禁止越界读取项目资源。');
  }
  return filename;
}
export function validateManifest(value: unknown): AppManifest {
  const item = value as AppManifest;
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id === 'shell' || !/^[a-z][a-z0-9-]{0,79}$/.test(item.id)
      || typeof item.appId !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+){2,}$/.test(item.appId)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80
      || typeof item.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(item.version)
      || typeof item.description !== 'string' || typeof item.renderer !== 'string'
      || typeof item.entry !== 'string' || !item.entry.endsWith('.html')
      || !Array.isArray(item.capabilities) || item.capabilities.some(cap => typeof cap !== 'string')) {
    throw new Error('应用描述无效，请检查 app.config.json。');
  }
  containedPath('/application', item.renderer);
  containedPath('/application', item.entry);
  if ('development' in item) throw new Error('开发版业务 App 已停用，请在 DreamEdge 中打开现有业务工程；原工程不会被删除。');
  if (item.services !== undefined && (!item.services || Array.isArray(item.services) || typeof item.services !== 'object')) throw new Error('服务列表无效。');
  for (const [id, service] of Object.entries(item.services ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(id) || !service || typeof service.entry !== 'string'
        || !service.entry.endsWith('.cjs') || !Array.isArray(service.methods)
        || !service.methods.length || service.methods.some(method => typeof method !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(method))) {
      throw new Error('本地服务描述无效。');
    }
    containedPath('/application', service.entry);
  }
  return item;
}
export function loadApplication(root: string): AppManifest {
  return validateManifest(JSON.parse(readFileSync(resolve(root, 'dist/app.json'), 'utf8')));
}
export function applicationDataDirectory(base: string, manifest: Pick<AppManifest, 'appId'>): string {
  if (!/^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+){2,}$/.test(manifest.appId)) throw new Error('应用标识无效。');
  return join(base, manifest.appId);
}
export function servicePath(root: string, entry: string): string {
  const actual = realpathSync(containedPath(root, entry));
  return containedPath(realpathSync(root), relative(realpathSync(root), actual));
}
