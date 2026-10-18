import type { Message } from '@earendil-works/pi-ai';
import { ModelAdapterError } from './errors.js';
import type { RuntimeRequest } from './types.js';
import { validateModelMessage } from './message-validation.js';

export function prepareContext(request: RuntimeRequest): Message[] {
  const invalid = () => { throw new ModelAdapterError('INVALID_CONTEXT', '运行标识或文字对话上下文无效。'); };
  if (typeof request.sessionId !== 'string' || !request.sessionId.trim()
    || typeof request.runId !== 'string' || !request.runId.trim()) invalid();
  if (!Array.isArray(request.messages) || !request.messages.length) invalid();
  if (request.continuation !== undefined && typeof request.continuation !== 'boolean') invalid();
  if (request.messages.at(-1)?.role !== (request.continuation ? 'toolResult' : 'user')) invalid();
  const pending = new Map<string, string>();
  for (const message of request.messages) {
    validateModelMessage(message);
    if (message.role === 'toolResult') {
      if (pending.get(message.toolCallId) !== message.toolName) invalid();
      pending.delete(message.toolCallId);
    } else {
      if (pending.size) invalid();
      if (message.role === 'assistant') {
        const calls = message.content.filter(block => block.type === 'toolCall');
        if (message.stopReason !== (calls.length ? 'toolUse' : 'stop')) invalid();
        for (const call of calls) {
          if (pending.has(call.id)) invalid();
          pending.set(call.id, call.name);
        }
      }
    }
  }
  if (pending.size) invalid();
  return structuredClone([...request.messages]);
}
