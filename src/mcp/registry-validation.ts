import { freezeDeep, jsonCopy, canonicalJson } from '../tools/json.js';
import { mcpConnectionIdentity, parseMcpServerConfig } from './config.js';
import { id, object, string } from './validation.js';
import type { McpConnectionIdentity } from './types.js';
import type { McpAppContext, McpAppScope, McpRegistryState } from './registry-types.js';

export class McpRegistryError extends Error {
  constructor(readonly code: 'INVALID_REGISTRY' | 'CONFLICT' | 'NOT_FOUND' | 'DUPLICATE' | 'DENIED' | 'STORE_FAILED' | 'CLOSED') {
    super({ INVALID_REGISTRY: 'MCP 登记或上下文数据无效。', CONFLICT: 'MCP 登记已变化，请刷新后重试。', NOT_FOUND: 'MCP 连接未登记。',
      DUPLICATE: 'MCP 连接标识已存在。', DENIED: 'MCP 连接未满足授权条件。', STORE_FAILED: 'MCP 登记无法读取或保存。', CLOSED: 'MCP 登记已关闭。' }[code]); this.name = 'McpRegistryError';
  }
}
export function checked<T>(parse: () => T): T {
  try { return parse(); } catch (error) { if (error instanceof McpRegistryError) throw error; throw new McpRegistryError('INVALID_REGISTRY'); }
}
export const sameMcpIdentity = (a: McpConnectionIdentity, b: McpConnectionIdentity) => canonicalJson(a) === canonicalJson(b);
export function identity(value: unknown): McpConnectionIdentity {
  const v = object(value, ['serverId', 'configRevision', 'configDigest'], 'identity');
  if (!Number.isSafeInteger(v.configRevision) || Number(v.configRevision) < 1 || typeof v.configDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.configDigest)) throw 0;
  return { serverId: id(v.serverId, 'serverId'), configRevision: v.configRevision as number, configDigest: v.configDigest };
}
export function appScope(value: unknown): McpAppScope {
  const v = object(value, ['appId', 'profileRef'], 'scope');
  if (typeof v.appId !== 'string' || !v.appId.trim() || (v.profileRef !== undefined && (typeof v.profileRef !== 'string' || !v.profileRef.trim()))) throw 0;
  return { appId: string(v.appId, 'appId', 256), ...(v.profileRef === undefined ? {} : { profileRef: string(v.profileRef, 'profileRef', 256) }) };
}
export function parseMcpAppContext(value: unknown): McpAppContext {
  return checked(() => {
    const v = object(jsonCopy(value), ['source', 'appId', 'profileRef', 'capturedAt', 'windowRef', 'resourceRef', 'contextRevision', 'connectionRef'], 'context');
    if (typeof v.source !== 'string' || !['user-selection', 'host-window', 'provider', 'untrusted'].includes(v.source) || !Number.isSafeInteger(v.capturedAt) || Number(v.capturedAt) < 0) throw 0;
    return freezeDeep({ source: v.source as McpAppContext['source'], capturedAt: v.capturedAt as number,
      ...appScope({ appId: v.appId, ...(v.profileRef === undefined ? {} : { profileRef: v.profileRef }) }),
      ...Object.fromEntries(['windowRef', 'resourceRef', 'contextRevision', 'connectionRef'].flatMap(k => v[k] === undefined ? [] : [[k, string(v[k], k, 4096)]])) });
  });
}
export function emptyMcpRegistry(): McpRegistryState {
  return { format: 'dreamedge-mcp-registry/v1', revision: 0, servers: [], associations: [], bindings: [] };
}
export function parseMcpRegistry(value: unknown): McpRegistryState {
  return checked(() => {
    const v = object(jsonCopy(value), ['format', 'revision', 'servers', 'associations', 'bindings'], 'registry');
    if (v.format !== 'dreamedge-mcp-registry/v1' || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0) throw 0;
    for (const [key, max] of [['servers', 128], ['associations', 512], ['bindings', 512]] as const) if (!Array.isArray(v[key]) || v[key].length > max) throw 0;
    const servers = (v.servers as unknown[]).map(value => {
      const s = object(value, ['config', 'revoked', 'approval'], 'server'); const config = parseMcpServerConfig(s.config);
      if (typeof s.revoked !== 'boolean') throw 0;
      if (s.approval === undefined) return { config, revoked: s.revoked };
      const a = object(s.approval, ['identity', 'approvedAt'], 'approval'); const grant = identity(a.identity);
      if (!sameMcpIdentity(grant, mcpConnectionIdentity(config)) || !Number.isSafeInteger(a.approvedAt) || Number(a.approvedAt) < 0
        || s.revoked || !config.enabled || config.policy.connect === 'deny') throw 0;
      return { config, revoked: false, approval: { identity: grant, approvedAt: a.approvedAt as number } };
    });
    const names = new Set(servers.map(s => s.config.serverId)); if (names.size !== servers.length) throw 0;
    const associations = (v.associations as unknown[]).map(value => {
      const a = object(value, ['appId', 'profileRef', 'serverId'], 'association'); const serverId = id(a.serverId, 'serverId'); if (!names.has(serverId)) throw 0;
      return { ...appScope({ appId: a.appId, ...(a.profileRef === undefined ? {} : { profileRef: a.profileRef }) }), serverId };
    });
    if (new Set(associations.map(a => canonicalJson(a))).size !== associations.length) throw 0;
    const bindings = (v.bindings as unknown[]).map(value => {
      const b = object(value, ['sessionId', 'identity', 'scope'], 'binding'); const ref = identity(b.identity); if (!names.has(ref.serverId)) throw 0;
      return { sessionId: id(b.sessionId, 'sessionId'), identity: ref, ...(b.scope === undefined ? {} : { scope: appScope(b.scope) }) };
    });
    if (new Set(bindings.map(b => b.sessionId)).size !== bindings.length) throw 0;
    return freezeDeep({ format: 'dreamedge-mcp-registry/v1', revision: v.revision as number, servers, associations, bindings });
  });
}
