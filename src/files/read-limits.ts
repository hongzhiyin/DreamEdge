import { FileScopeError } from './scope-types.js';
import type { JsonObject } from '@earendil-works/pi-ai';
export const readToolNames = ['read', 'ls', 'find', 'grep'] as const;
export type ReadToolName = typeof readToolNames[number];
export interface ReadLimits { fileBytes: number; totalBytes: number; entries: number; depth: number; timeoutMs: number }
export const defaultReadLimits: Readonly<ReadLimits> = Object.freeze({ fileBytes: 4 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024, entries: 1024, depth: 32, timeoutMs: 20_000 });
export function readLimits(options: Partial<ReadLimits> = {}): ReadLimits {
  const limits = { ...defaultReadLimits, ...options };
  for (const key of Object.keys(limits) as (keyof ReadLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > defaultReadLimits[key]) {
      throw new FileScopeError('FILE_SCOPE_INVALID', '读取与搜索预算无效。');
    }
  }
  return Object.freeze(limits);
}
export function validateReadOptions(name: ReadToolName, args: JsonObject): void {
  for (const key of ['offset', 'limit', 'context']) {
    const value = args[key]; if (value === undefined) continue;
    const max = key === 'offset' ? 10_000_000 : key === 'context' ? 20 : 1000;
    if (!Number.isSafeInteger(value) || Number(value) < (key === 'context' ? 0 : 1) || Number(value) > max) {
      throw new FileScopeError('FILE_SCOPE_INVALID', '读取窗口或搜索结果上限无效。');
    }
  }
  for (const key of ['pattern', 'glob']) if (args[key] !== undefined
    && (typeof args[key] !== 'string' || String(args[key]).length > 4096 || String(args[key]).includes('\0'))) {
    throw new FileScopeError('FILE_SCOPE_INVALID', '搜索表达式无效。');
  }
  if (name === 'find' && (!args.pattern || String(args.pattern).startsWith('!') || String(args.pattern).split('/').includes('..'))) {
    throw new FileScopeError('FILE_SCOPE_INVALID', '文件匹配表达式不能取反或包含上级路径。');
  }
}
