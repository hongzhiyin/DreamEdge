import { createHash } from 'node:crypto';
import type { JsonValue } from '@earendil-works/pi-ai';
import { ToolContractError } from './errors.js';

/** Rejects values JSON.stringify would silently omit or change. */
export function canonicalJson(value: unknown, schemaAnnotations = false): string {
  const ancestors = new Set<object>();
  const invalid = (): never => { throw new ToolContractError('INVALID_JSON', '工具数据必须是有限、无循环的 JSON 值。'); };
  const visit = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number') return Number.isFinite(item) ? JSON.stringify(item) : invalid();
    if (!item || typeof item !== 'object' || ancestors.has(item)) return invalid();
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return invalid();
    if (Object.getOwnPropertySymbols(item).length) return invalid();
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.values(descriptors).some(field => !('value' in field))) return invalid();
      if (schemaAnnotations) {
        for (const key of ['~kind', '~optional', '~readonly']) {
          const field = descriptors[key];
          if (field && !field.enumerable && ['string', 'boolean'].includes(typeof field.value)) delete descriptors[key];
        }
      }
      if (Array.isArray(item)) {
        const keys = Object.keys(item);
        if (Object.keys(descriptors).length !== item.length + 1 || keys.length !== item.length
          || keys.some((key, i) => key !== String(i))) return invalid();
        return `[${item.map(visit).join(',')}]`;
      }
      if (Object.values(descriptors).some(field => !field.enumerable)) return invalid();
      return `{${Object.keys(descriptors).sort().map(key => `${JSON.stringify(key)}:${visit(descriptors[key]!.value)}`).join(',')}}`;
    } finally { ancestors.delete(item); }
  };
  return visit(value);
}

export function argumentsDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function jsonCopy(value: unknown, schemaAnnotations = false): JsonValue {
  return JSON.parse(canonicalJson(value, schemaAnnotations)) as JsonValue;
}

export function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
