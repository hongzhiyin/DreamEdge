import { ToolContractError } from '../tools/errors.js';
import type { RunMessageRecord } from './tool-contracts.js';
import { validateModelMessage } from '../model/message-validation.js';

/** Validates ordering and call/result pairing, not provider-specific message internals. */
export function assertRunTranscript(
  records: readonly RunMessageRecord[], owner: { sessionId: string; runId: string }, requireClosed = true,
): void {
  const invalid = (): never => { throw new ToolContractError('INVALID_TRANSCRIPT', '运行消息顺序或工具结果归属无效。'); };
  const ids = new Set<string>();
  const calls = new Set<string>();
  const turns = new Set<string>();
  const pending = new Map<string, { name: string; turnId: string }>();
  for (const [ordinal, record] of records.entries()) {
    if (record.sessionId !== owner.sessionId || record.runId !== owner.runId || record.ordinal !== ordinal
      || !record.messageId?.trim() || !record.turnId?.trim() || ids.has(record.messageId)) invalid();
    ids.add(record.messageId);
    const message = record.message;
    validateModelMessage(message);
    if (message.role === 'assistant') {
      if (message.stopReason === 'pending') invalid();
      if (pending.size || turns.has(record.turnId)) invalid();
      turns.add(record.turnId);
      const tools = message.content.filter(block => block.type === 'toolCall');
      if (tools.length && message.stopReason !== 'toolUse') invalid();
      for (const tool of tools) {
        if (!tool.id?.trim() || !tool.name?.trim() || calls.has(tool.id)) invalid();
        calls.add(tool.id); pending.set(tool.id, { name: tool.name, turnId: record.turnId });
      }
    } else if (message.role === 'toolResult') {
      const call = pending.get(message.toolCallId);
      if (!call || call.name !== message.toolName || call.turnId !== record.turnId) invalid();
      pending.delete(message.toolCallId);
    } else if (message.role !== 'system' || pending.size) invalid();
  }
  if (requireClosed && pending.size) invalid();
}
