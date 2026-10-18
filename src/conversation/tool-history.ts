import type { Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { RunRecord } from './types.js';
import { canonicalJson } from '../tools/json.js';
import { ModelAdapterError } from '../model/errors.js';

function closedBoundary(run: RunRecord): number {
  const pending = new Set<string>();
  let boundary = -1;
  for (const [index, entry] of (run.transcript ?? []).entries()) {
    if (entry.message.role === 'assistant') for (const block of entry.message.content) {
      if (block.type === 'toolCall') pending.add(block.id);
    }
    else if (entry.message.role === 'toolResult') {
      pending.delete(entry.message.toolCallId);
      if (!pending.size) boundary = index;
    }
  }
  return boundary;
}

/** Complete call batches remain context even if a later reply attempt failed. */
export function questionHistory(attempts: readonly RunRecord[], includeAnswer = true): Message[] {
  const context: Message[] = [];
  const seen = new Map<string, string>();
  const complete = includeAnswer ? [...attempts].reverse().find(run => run.status === 'completed') : undefined;
  for (const run of attempts) {
    const boundary = closedBoundary(run);
    appendBatches(context, (run.transcript ?? []).slice(0, boundary + 1).map(entry => entry.message), seen);
    if (run === complete) {
      if (run.transcript) context.push(...run.transcript.slice(boundary + 1).map(entry => entry.message));
      else if (run.nativeMessage) context.push(run.nativeMessage);
      break;
    }
  }
  if (includeAnswer && !complete && context.length) {
    context.push({ role: 'system', timestamp: attempts.at(-1)?.finishedAt ?? attempts.at(-1)!.createdAt,
      content: '此提问未形成完整回答；已记录的工具结果仍然有效。中断或失败不代表动作没有发生，不得据此重复写操作。' });
  }
  return structuredClone(context);
}

function appendBatches(context: Message[], messages: readonly Message[], seen: Map<string, string>): void {
  let batch: Message[] = [];
  let calls: ToolCall[] = [];
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    batch.push(message);
    if (message.role === 'assistant') calls = message.content.filter(block => block.type === 'toolCall');
    if (message.role !== 'toolResult') continue;
    results.set(message.toolCallId, message);
    if (results.size !== calls.length) continue;
    const signatures = calls.map(call => {
      const result = results.get(call.id)!;
      return [call.id, canonicalJson({ name: call.name, args: call.arguments,
        content: result.content, isError: result.isError, details: result.details ?? null })] as const;
    });
    const known = signatures.filter(([id]) => seen.has(id));
    if (known.length && (known.length !== signatures.length || signatures.some(([id, signature]) => seen.get(id) !== signature))) {
      throw new ModelAdapterError('INVALID_CONTEXT', '重复工具标识对应不同结果，不能自动合并历史。');
    }
    if (!known.length) { context.push(...batch); for (const [id, signature] of signatures) seen.set(id, signature); }
    batch = []; calls = []; results.clear();
  }
}
