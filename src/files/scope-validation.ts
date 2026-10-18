import { isAbsolute, normalize } from 'node:path';
import { canonicalJson } from '../tools/json.js';
import { FileScopeError } from './scope-types.js';
import type { FileScopeState, FileDestination } from './scope-types.js';

const text = (v: unknown) => typeof v === 'string' && v.length > 0 && !v.includes('\0');
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const decimal = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v);
const path = (v: unknown) => text(v) && isAbsolute(String(v)) && normalize(String(v)) === v;
const identity = (v: { device: string; inode: string }) => v && decimal(v.device) && decimal(v.inode);
const timestamp = (v: unknown) => Number.isFinite(v) && Number(v) >= 0;
export function sameDestination(a: FileDestination, b: FileDestination): boolean { return canonicalJson(a) === canonicalJson(b); }
function destination(v: FileDestination): boolean {
  if (!v || ![v.connectionId, v.protocol, v.baseUrl, v.model].every(text)) return false;
  const u = new URL(v.baseUrl);
  return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
}
export function exclusion(value: string): boolean {
  return text(value) && value.length <= 4096 && !isAbsolute(value) && !value.includes('\\') && !/[?*]/.test(value)
    && value.split('/').every(part => part !== '.' && part !== '..' && part.length > 0);
}
export function assertFileScope(scope: FileScopeState, sessionId: string): void {
  try {
    if (!scope || !integer(scope.policyVersion) || !Array.isArray(scope.grants) || !Array.isArray(scope.observations)) throw 0;
    if (scope.grants.length > 64 || scope.observations.length > 1024) throw 0;
    const ids = new Set<string>(); const roots = new Set<string>();
    for (const g of scope.grants) {
      if (!g || !text(g.grantId) || ids.has(g.grantId) || roots.has(g.rootId) || !text(g.rootId)
        || g.sessionId !== sessionId || !path(g.path) || !identity(g.identity) || !destination(g.destination)
        || !['read', 'read-write'].includes(g.mode) || typeof g.remember !== 'boolean' || !timestamp(g.createdAt)
        || !Array.isArray(g.excludes) || g.excludes.length > 128 || !g.excludes.every(exclusion)
        || (g.expiresAt !== undefined && (!timestamp(g.expiresAt) || g.expiresAt <= g.createdAt))
        || (g.revokedAt !== undefined && (!timestamp(g.revokedAt) || g.revokedAt < g.createdAt))) throw 0;
      if (g.device !== undefined && (!g.device || Object.keys(g.device).some(key => key !== 'baseDirectory')
        || !path(g.device.baseDirectory) || g.mode !== 'read-write' || !g.remember || g.excludes.length || g.expiresAt !== undefined)) throw 0;
      ids.add(g.grantId); roots.add(g.rootId);
    }
    const observations = new Set<string>();
    for (const o of scope.observations) {
      const g = scope.grants.find(g => g.grantId === o.grantId);
      if (!g || g.rootId !== o.rootId || !text(o.observationId) || observations.has(o.observationId)
        || !integer(o.policyVersion) || o.policyVersion > scope.policyVersion || !path(o.path)
        || !destination(o.destination) || !sameDestination(o.destination, g.destination)
        || !identity(o.version) || ![o.version.size, o.version.modifiedNs, o.version.changedNs].every(decimal)
        || !/^[a-f0-9]{64}$/.test(o.version.sha256) || !timestamp(o.observedAt) || typeof o.complete !== 'boolean'
        || !o.source || o.source.sessionId !== sessionId
        || ![o.source.runId, o.source.turnId, o.source.toolCallId].every(text)) throw 0;
      observations.add(o.observationId);
    }
  } catch { throw new FileScopeError('FILE_SCOPE_INVALID', '文件范围记录无效。'); }
}
