import type { ThinkingLevelMap } from '@earendil-works/pi-ai';
import { ModelAdapterError } from './errors.js';
import { protocols, thinkingLevels } from './types.js';
import type { ModelConnectionConfig, ThinkingFormat, ThinkingLevel } from './types.js';

function invalid(field: string): never {
  throw new ModelAdapterError('INVALID_CONFIG', `模型连接配置字段无效：${field}。`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) return invalid(field);
  return value.trim();
}
function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) return invalid(field);
  return value as number;
}
function level(value: unknown, field: string): ThinkingLevel {
  if (!thinkingLevels.includes(value as ThinkingLevel)) return invalid(field);
  return value as ThinkingLevel;
}

export function parseModelConnection(value: unknown): ModelConnectionConfig {
  const input = object(value, 'connection');
  const allowed = ['id', 'protocol', 'baseUrl', 'model', 'contextWindow', 'maxOutputTokens',
    'credentialRef', 'thinkingLevel', 'timeoutMs', 'reasoning', 'toolCalling'];
  if (Object.keys(input).some(key => !allowed.includes(key))) invalid('unknown property');
  if (!protocols.includes(input.protocol as ModelConnectionConfig['protocol'])) invalid('protocol');
  const baseUrl = string(input.baseUrl, 'baseUrl');
  let url: URL;
  try { url = new URL(baseUrl); } catch { return invalid('baseUrl'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    invalid('baseUrl');
  }
  const config: ModelConnectionConfig = {
    id: string(input.id, 'id'),
    protocol: input.protocol as ModelConnectionConfig['protocol'],
    baseUrl: baseUrl.replace(/\/$/, ''),
    model: string(input.model, 'model'),
    credentialRef: string(input.credentialRef, 'credentialRef'),
    contextWindow: integer(input.contextWindow, 'contextWindow'),
    maxOutputTokens: integer(input.maxOutputTokens, 'maxOutputTokens'),
  };
  if (config.maxOutputTokens > config.contextWindow) invalid('maxOutputTokens');
  if (input.timeoutMs !== undefined) {
    config.timeoutMs = integer(input.timeoutMs, 'timeoutMs');
    if (config.timeoutMs > 2_147_483_647) invalid('timeoutMs');
  }
  if (input.thinkingLevel !== undefined) config.thinkingLevel = level(input.thinkingLevel, 'thinkingLevel');
  if (input.reasoning !== undefined) {
    const source = object(input.reasoning, 'reasoning');
    if (Object.keys(source).some(key => !['supportedLevels', 'effortMap', 'format'].includes(key))) {
      invalid('reasoning property');
    }
    if (!Array.isArray(source.supportedLevels) || !source.supportedLevels.length) invalid('supportedLevels');
    config.reasoning = { supportedLevels: [...new Set(source.supportedLevels.map(x => level(x, 'supportedLevels')))] };
    if (source.format !== undefined) {
      const formats = ['openai', 'deepseek', 'openrouter', 'zai', 'qwen'];
      if (!formats.includes(source.format as string) || config.protocol !== 'openai-completions') invalid('format');
      config.reasoning.format = source.format as ThinkingFormat;
    }
    if (source.effortMap !== undefined) {
      const map = object(source.effortMap, 'effortMap');
      const result: ThinkingLevelMap = {};
      for (const [key, val] of Object.entries(map)) {
        const name = level(key, 'effortMap key');
        if (val !== null && (typeof val !== 'string' || !val)) invalid('effortMap value');
        if (val === null && config.reasoning.supportedLevels.includes(name)) invalid('effortMap support');
        result[name] = val as string | null;
      }
      config.reasoning.effortMap = result;
    }
  }
  if (input.toolCalling !== undefined) {
    const source = object(input.toolCalling, 'toolCalling');
    if (Object.keys(source).some(key => !['supported', 'supportedThinkingLevels'].includes(key))) invalid('toolCalling property');
    if (source.supported === false) {
      if (source.supportedThinkingLevels !== undefined) invalid('toolCalling supportedThinkingLevels');
      config.toolCalling = { supported: false };
    } else if (source.supported === true) {
      if (!Array.isArray(source.supportedThinkingLevels) || !source.supportedThinkingLevels.length) invalid('toolCalling supportedThinkingLevels');
      const levels = source.supportedThinkingLevels.map(value => level(value, 'toolCalling supportedThinkingLevels'));
      if (levels.some(value => !(config.reasoning?.supportedLevels ?? ['off']).includes(value))) invalid('toolCalling thinking support');
      config.toolCalling = { supported: true, supportedThinkingLevels: [...new Set(levels)] };
    } else invalid('toolCalling supported');
  }
  return config;
}
