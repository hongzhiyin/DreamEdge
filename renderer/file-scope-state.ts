import type { FileDestination, FileScopeOverview } from '../src/files/scope-types.js';

export function destinationLabel(destination: FileDestination): string {
  return `${destination.model} · ${destination.baseUrl}`;
}
export function grantStatus(grant: FileScopeOverview['grants'][number], current: FileDestination, now: number) {
  if (grant.revokedAt !== undefined) return '已撤销';
  if (grant.expiresAt !== undefined && grant.expiresAt <= now) return '已过期';
  if (['connectionId', 'protocol', 'baseUrl', 'model'].some(key =>
    grant.destination[key as keyof FileDestination] !== current[key as keyof FileDestination])) return '模型服务已变化';
  return '授权中';
}
