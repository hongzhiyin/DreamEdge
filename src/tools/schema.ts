import { Check } from 'typebox/schema';
import type { JsonObject, JsonValue } from '@earendil-works/pi-ai';
import { ToolContractError } from './errors.js';
import { jsonCopy } from './json.js';
import type { ToolSnapshot } from './types.js';

const keys = new Set(['type', 'title', 'description', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'const', 'anyOf', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', '$schema', 'default', 'oneOf']);

/** Portable JSON Schema subset evaluated by TypeBox; remote references and executable types stay excluded. */
export function parameterSchema(value: unknown): JsonObject {
  const invalid = (): never => { throw new ToolContractError('INVALID_TOOL_DEFINITION', '工具参数 Schema 无效或不受支持。'); };
  let schema: JsonValue;
  try { schema = jsonCopy(value, true); } catch { return invalid(); }
  const object = (item: JsonValue | undefined): item is JsonObject => Boolean(item && typeof item === 'object' && !Array.isArray(item));
  const visit = (item: JsonValue | undefined): void => {
    if (!object(item)) return invalid();
    if (Object.keys(item).some(key => !keys.has(key))) return invalid();
    if (item.$schema !== undefined && item.$schema !== 'http://json-schema.org/draft-07/schema#') invalid();
    for (const key of ['title', 'description', 'pattern']) {
      if (item[key] !== undefined && typeof item[key] !== 'string') invalid();
    }
    if (item.pattern !== undefined) { try { new RegExp(item.pattern as string); } catch { invalid(); } }
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) {
      if (item[key] !== undefined && typeof item[key] !== 'number') invalid();
    }
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0)) invalid();
    }
    if (item.enum !== undefined && (!Array.isArray(item.enum) || !item.enum.length)) invalid();
    if (item.type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(item.type))) invalid();
    for (const keyword of ['anyOf', 'oneOf']) {
      const variants = item[keyword];
      if (variants !== undefined) {
        if (!Array.isArray(variants) || !variants.length) return invalid();
        variants.forEach(visit);
      }
    }
    if (item.type === undefined && item.enum === undefined && !Object.hasOwn(item, 'const')
      && item.anyOf === undefined && item.oneOf === undefined) invalid();
    if (item.type === 'object') {
      const properties = item.properties;
      if (!object(properties) || (item.additionalProperties !== undefined && typeof item.additionalProperties !== 'boolean')) return invalid();
      Object.values(properties).forEach(visit);
      if (item.required !== undefined && (!Array.isArray(item.required)
        || item.required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key))
        || new Set(item.required).size !== item.required.length)) invalid();
    } else if (item.properties !== undefined || item.required !== undefined || item.additionalProperties !== undefined) invalid();
    if (item.type === 'array') visit(item.items);
    else if (item.items !== undefined) invalid();
  };
  visit(schema);
  if (!object(schema) || schema.type !== 'object') return invalid();
  return schema;
}

export function validateToolArguments(tool: ToolSnapshot, value: unknown): JsonObject {
  try {
    const args = jsonCopy(value);
    if (!args || typeof args !== 'object' || Array.isArray(args) || !Check(tool.parameters, args)) throw new Error();
    return args as JsonObject;
  } catch { throw new ToolContractError('INVALID_TOOL_ARGUMENTS', '工具参数与声明不匹配。'); }
}
