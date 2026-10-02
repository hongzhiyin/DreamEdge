import type { Json, StorageRequest } from './contracts';

export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
    throw new Error('无效的存储标识。');
  }
}

function isJson(value: unknown, depth = 0): value is Json {
  if (depth > 20) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJson(item, depth + 1));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(item => isJson(item, depth + 1));
}

export function validateStorage(input: unknown): asserts input is StorageRequest {
  if (!input || typeof input !== 'object') throw new Error('无效的存储请求。');
  const request = input as Record<string, unknown>;
  identifier(request.collection);
  if (!['list', 'put', 'remove'].includes(String(request.operation))) {
    throw new Error('不支持的存储操作。');
  }
  if (request.operation !== 'list') identifier(request.id);
  if (request.operation === 'put') {
    if (!isJson(request.value) || new TextEncoder().encode(JSON.stringify(request.value)).byteLength > 64 * 1024) {
      throw new Error('记录必须是有效 JSON，且不超过 64 KB。');
    }
  }
}
