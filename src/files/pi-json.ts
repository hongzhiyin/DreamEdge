import type { JsonObject, JsonValue } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import { jsonCopy } from '../tools/json.js';
import { parameterSchema } from '../tools/schema.js';

/** Tightens only object openness; preserves Pi's input fields and editing semantics. */
export function piParameters(source: TSchema): JsonObject {
  const schema = jsonCopy(source, true) as JsonObject;
  const close = (value: JsonValue): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as JsonObject;
    if (item.type === 'object') {
      item.additionalProperties = false;
      if (item.properties && typeof item.properties === 'object' && !Array.isArray(item.properties)) {
        Object.values(item.properties as JsonObject).forEach(close);
      }
    }
    if (item.items) close(item.items);
    if (Array.isArray(item.anyOf)) item.anyOf.forEach(close);
  };
  close(schema); return parameterSchema(schema);
}

/** Pi uses undefined for absent metadata. Omit it in objects, but reject lossy JSON values. */
export function piDetails(source: unknown): JsonValue {
  const ancestors = new Set<object>();
  const visit = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    if (ancestors.has(value)) throw new Error('Cyclic Pi result');
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('Invalid Pi result');
    if (Object.getOwnPropertySymbols(value).length) throw new Error('Invalid Pi result');
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.values(fields).some(field => !('value' in field))) throw new Error('Invalid Pi result');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length || Object.keys(fields).length !== value.length + 1) throw new Error('Invalid Pi array');
        return value.map(visit);
      }
      if (Object.values(fields).some(field => !field.enumerable)) throw new Error('Invalid Pi result');
      return Object.fromEntries(Object.entries(fields).filter(([, field]) => field.value !== undefined)
        .map(([key, field]) => [key, visit(field.value)]));
    } finally { ancestors.delete(value); }
  };
  return jsonCopy(source === undefined ? {} : visit(source));
}
