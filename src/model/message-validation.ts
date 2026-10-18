import type { Message } from '@earendil-works/pi-ai';
import { canonicalJson } from '../tools/json.js';
import { parameterSchema } from '../tools/schema.js';
import { ModelAdapterError } from './errors.js';

const text = (value: unknown) => typeof value === 'string' && Boolean(value.trim());
function invalid(): never { throw new ModelAdapterError('INVALID_CONTEXT', '原生模型消息无效。'); }

export function validateModelMessage(message: Message): void {
  try { validatePayload(message); } catch { invalid(); }
}

function validatePayload(message: Message): void {
  if (!message || typeof message !== 'object' || !Number.isFinite(message.timestamp)
    || !['system', 'user', 'assistant', 'toolResult'].includes(message.role)) invalid();
  if (message.role === 'assistant') {
    if (!text(message.api) || !text(message.provider) || !text(message.model)
      || !['pending', 'stop', 'toolUse', 'length', 'error', 'aborted'].includes(message.stopReason)
      || !message.usage || !message.usage.cost) invalid();
    for (const value of [message.usage.input, message.usage.output, message.usage.cacheRead,
      message.usage.cacheWrite, message.usage.totalTokens, ...Object.values(message.usage.cost)]) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid();
    }
  }
  if (message.role === 'toolResult' && (!text(message.toolCallId) || !text(message.toolName) || typeof message.isError !== 'boolean')) invalid();
  if (typeof message.content === 'string') {
    if (message.role !== 'user' && message.role !== 'system') invalid();
  } else {
    if (!Array.isArray(message.content)) invalid();
    for (const block of message.content) {
      if (!block || typeof block !== 'object') invalid();
      if (block.type === 'text') { if (typeof block.text !== 'string') invalid(); }
      else if (block.type === 'thinking' && message.role === 'assistant') {
        if (typeof block.thinking !== 'string') invalid();
      } else if (block.type === 'toolCall' && message.role === 'assistant') {
        if (!text(block.id) || !text(block.name) || !block.arguments || typeof block.arguments !== 'object'
          || Array.isArray(block.arguments)) invalid();
        canonicalJson(block.arguments);
      } else if (block.type === 'image' && message.role === 'toolResult') {
        if (typeof block.data !== 'string' || !text(block.mimeType)) invalid();
      } else invalid();
    }
  }
  if (message.role === 'system') {
    if (message.toolsAdded !== undefined) {
      if (!Array.isArray(message.toolsAdded)) invalid();
      for (const tool of message.toolsAdded) {
        if (!tool || !text(tool.name) || typeof tool.description !== 'string') invalid();
        parameterSchema(tool.parameters);
      }
    }
    if (message.toolsRemoved !== undefined && (!Array.isArray(message.toolsRemoved)
      || message.toolsRemoved.some(tool => !tool || !text(tool.name)))) invalid();
    if (message.sections !== undefined) canonicalJson(message.sections);
  }
  if (message.role === 'toolResult' && message.details !== undefined) canonicalJson(message.details);
}
