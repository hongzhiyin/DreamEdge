import { createRequire } from 'node:module';
import type { AppManifest, Json } from '../shared/contracts';
import { servicePath } from './project';
import { isJson } from '../shared/storage-validation';
type Service = { execute(method: string, input: Json, context: { dataDirectory: string; appId: string }): Promise<Json> };
export function createServices(manifest: AppManifest, root: string, dataDirectory: string) {
  const require = createRequire(__filename);
  const loaded = new Map<string, Service>();
  const active = new Set<string>();
  return async (service: string, method: string, input: Json): Promise<Json> => {
    if (typeof service !== 'string' || typeof method !== 'string') throw new Error('无效的服务请求。');
    const definition = Object.hasOwn(manifest.services ?? {}, service) ? manifest.services![service] : undefined;
    if (!definition || !manifest.capabilities.includes(`service:${service}`) || !definition.methods.includes(method)) throw new Error('应用未声明此服务能力。');
    if (active.has(service)) throw new Error('请求正在进行，请稍后再试。');
    const serialized = JSON.stringify(input);
    if (!isJson(input) || serialized === undefined || serialized.length > 65536) throw new Error('服务请求过大或无效。');
    let module = loaded.get(service);
    if (!module) {
      module = require(servicePath(root, definition.entry)) as Service;
      if (!module || typeof module.execute !== 'function') throw new Error('本地服务入口无效。');
      loaded.set(service, module);
    }
    active.add(service);
    try {
      const result = await module.execute(method, input, { dataDirectory, appId: manifest.appId });
      const output = JSON.stringify(result);
      if (!isJson(result) || output === undefined || output.length > 1048576) throw new Error('服务响应过大或无效。');
      return JSON.parse(output) as Json;
    } finally { active.delete(service); }
  };
}
