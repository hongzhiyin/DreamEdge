import { ConversationError } from '../conversation/state.js';
import { thinkingLevels } from '../model/types.js';
import type { ChatCommand } from './types.js';

const invalid = (): never => { throw new ConversationError('INVALID_COMMAND', '聊天命令无效。'); };
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) return invalid();
  return record;
}
function text(value: unknown, limit = 256): void {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) invalid();
}

export function chatCommand(value: unknown): ChatCommand {
  const input = object(value, ['type', 'sessionId', 'cursor', 'input', 'runId', 'decision', 'mode', 'reference']);
  if (input.type === 'initialize' || input.type === 'create') object(value, ['type']);
  else if (input.type === 'send') {
    object(value, ['type', 'input']);
    const send = object(input.input, ['sessionId', 'clientMessageId', 'text', 'thinkingLevel']);
    text(send.sessionId); text(send.clientMessageId); text(send.text, 100_000);
    if (send.thinkingLevel !== undefined && !thinkingLevels.includes(send.thinkingLevel as never)) invalid();
  } else if (input.type === 'resumeBatch') {
    object(value, ['type', 'reference']);
    const ref = object(input.reference, ['sessionId', 'sourceRunId', 'approvalId', 'digest']);
    for (const key of ['sessionId', 'sourceRunId', 'approvalId', 'digest']) text(ref[key]);
  } else if (input.type === 'approval') {
    object(value, ['type', 'decision']);
    const decision = object(input.decision, ['sessionId', 'runId', 'turnId', 'toolCallId', 'approvalId',
      'toolName', 'toolVersion', 'argsDigest', 'decision', 'planDigest', 'policyVersion', 'batchDigest']);
    for (const key of ['sessionId', 'runId', 'turnId', 'toolCallId', 'approvalId', 'toolName', 'toolVersion', 'argsDigest']) text(decision[key]);
    if (decision.batchDigest !== undefined) text(decision.batchDigest);
    if (decision.planDigest !== undefined) text(decision.planDigest);
    if (decision.policyVersion !== undefined && (!Number.isSafeInteger(decision.policyVersion) || Number(decision.policyVersion) < 0)) invalid();
    if (!['approve', 'reject'].includes(String(decision.decision))) invalid();
  } else if (['watch', 'stop', 'retry', 'retrySave'].includes(String(input.type))) {
    object(value, input.type === 'watch' ? ['type', 'sessionId', 'cursor']
      : input.type === 'retrySave' ? ['type', 'sessionId'] : input.type === 'retry'
        ? ['type', 'sessionId', 'runId', 'mode'] : ['type', 'sessionId', 'runId']);
    if (input.mode !== undefined && !['continue', 'read_tools'].includes(String(input.mode))) invalid();
    text(input.sessionId);
    if (input.type === 'stop' || input.type === 'retry') text(input.runId);
    if (input.cursor !== undefined) {
      const cursor = object(input.cursor, ['epoch', 'sequence']);
      text(cursor.epoch);
      if (!Number.isSafeInteger(cursor.sequence) || Number(cursor.sequence) < 0) invalid();
    }
  } else invalid();
  return structuredClone(input) as unknown as ChatCommand;
}
