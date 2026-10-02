import { randomUUID } from 'node:crypto';
import type { ProjectDefinition } from '../../shared/contracts';
import { dependencies, validateLock } from '../dependencies/policy';

export const DEFINITION_FILE = '.dreamedge/project.json';
export function projectName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('工程名称需要 1–80 个字符。');
  return value.trim();
}
export function projectVersion(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error('工程版本必须采用数字形式，例如 0.1.0。');
  return value;
}
export function validateDefinition(value: unknown): ProjectDefinition {
  const item = value as ProjectDefinition;
  if (!item || typeof item !== 'object' || item.schemaVersion !== 1
      || typeof item.id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item.id)
      || typeof item.appId !== 'string' || !/^[a-z][a-z0-9]*(\.[a-z0-9-]+){2,}$/.test(item.appId)
      || item.source !== 'src' || item.build?.kind !== 'web' || item.build.entry !== 'index.html'
      || typeof item.savedAt !== 'string' || !Number.isFinite(Date.parse(item.savedAt))) throw new Error('工程描述格式无效或版本不受支持。');
  projectName(item.name); projectVersion(item.version);
  dependencies(item.dependencies);
  if (item.dependencyLock !== undefined) validateLock(item.dependencyLock, item.dependencies);
  return item;
}
export function createDefinition(name: unknown): ProjectDefinition {
  const id = randomUUID();
  return { schemaVersion: 1, id, name: projectName(name), appId: `io.dreamedge.project.p${id.replaceAll('-', '')}`,
    version: '0.1.0', source: 'src', dependencies: {}, build: { kind: 'web', entry: 'index.html' }, savedAt: new Date().toISOString() };
}
