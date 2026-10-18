import type { FileScopeState } from './scope-types.js';

/** Remembered directories retain their identity, which must be checked at every access. */
export function recoverFileScope(scope: FileScopeState | undefined, now: number): boolean {
  if (!scope) return false;
  let changed = false;
  for (const grant of scope.grants) {
    if (grant.revokedAt === undefined && (!grant.remember || (grant.expiresAt !== undefined && grant.expiresAt <= now))) {
      grant.revokedAt = Math.max(now, grant.createdAt); changed = true;
    }
  }
  if (changed) scope.policyVersion++;
  return changed;
}
