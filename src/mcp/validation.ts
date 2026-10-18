import { posix, win32 } from 'node:path';
import type { McpCredentialRef } from './types.js';

export class McpConfigError extends Error {
  readonly code = 'INVALID_MCP_CONFIG';
  constructor(readonly field: string) { super(`MCP 连接配置字段无效：${field}。`); this.name = 'McpConfigError'; }
}
export function invalid(field: string): never { throw new McpConfigError(field); }
export function object(value: unknown, allowed: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => !allowed.includes(key))) invalid(field);
  return source;
}
export function string(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0')) return invalid(field);
  return value;
}
export function id(value: unknown, field: string): string {
  const result = string(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) invalid(field);
  return result;
}
export function integer(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) return invalid(field);
  return value as number;
}
export function absolutePath(value: unknown, field: string): string {
  const result = string(value, field);
  if (!posix.isAbsolute(result) && !win32.isAbsolute(result)) invalid(field);
  // Drive-relative/root-relative Windows paths are not fully qualified.
  if (!result.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(result) && !result.startsWith('\\\\')) invalid(field);
  return result;
}
export function credentialRef(value: unknown, field: string): McpCredentialRef {
  const result = string(value, field, 140);
  if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(result) && !/^file:[A-Za-z0-9_.-]+$/.test(result)) invalid(field);
  return result as McpCredentialRef;
}
