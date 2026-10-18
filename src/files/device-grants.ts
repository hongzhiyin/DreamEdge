import { randomUUID } from 'node:crypto';
import type { FileScopeState, FileDestination, DeviceAccessPolicy } from './scope-types.js';
import { FileScopeError } from './scope-types.js';
import { sameIdentity } from './scope-paths.js';
import { sameDestination } from './scope-validation.js';

/** Only a trusted host policy can materialize whole-device grants. Old grants remain audit records. */
export function syncDeviceGrants(scope: FileScopeState, sessionId: string, destination: FileDestination,
  policy: DeviceAccessPolicy | undefined, now: number): boolean {
  let changed = false;
  for (const grant of scope.grants.filter(g => g.device && g.revokedAt === undefined)) {
    if (!policy || !sameDestination(grant.destination, destination) || grant.device!.baseDirectory !== policy.baseDirectory
      || !policy.roots.some(root => root.path === grant.path && sameIdentity(root.identity, grant.identity))) {
      grant.revokedAt = Math.max(now, grant.createdAt); changed = true;
    }
  }
  for (const root of policy?.roots ?? []) {
    if (scope.grants.some(g => g.device && g.revokedAt === undefined && g.path === root.path)) continue;
    if (scope.grants.length >= 64) throw new FileScopeError('FILE_SCOPE_INVALID', '目录授权数量已达上限，无法添加整机范围。');
    scope.grants.push({ grantId: randomUUID(), rootId: randomUUID(), sessionId, path: root.path, identity: { ...root.identity },
      mode: 'read-write', excludes: [], destination: structuredClone(destination), remember: true, createdAt: now,
      device: { baseDirectory: policy!.baseDirectory } }); changed = true;
  }
  if (changed) scope.policyVersion++;
  return changed;
}
