import { randomUUID } from 'node:crypto';
import type { RunRecord } from './types.js';
import type { ToolCallRecord } from '../tools/types.js';
import { hasRunData } from './run-data.js';
import type { ToolRunData } from '../runtime/tool-contracts.js';

/** Reconstructs outcomes only for calls already requested by the model; never executes an action. */
export function recoverToolRun(run: Pick<RunRecord, 'sessionId' | 'runId'> & Partial<ToolRunData>, now: number): boolean {
  if (!hasRunData(run)) return false;
  let changed = false;
  run.toolCalls = run.toolCalls.map(call => {
    if (!['requested', 'awaiting_approval', 'authorized', 'running'].includes(call.status)) return call;
    changed = true;
    const finishedAt = Math.max(now, call.createdAt, 'startedAt' in call ? call.startedAt ?? 0 : 0);
    if (call.status === 'running' && call.effect === 'write') {
      return { ...call, status: 'outcome_unknown', finishedAt,
        error: { code: 'OUTCOME_UNKNOWN', message: '进程中断，无法确认该写操作是否已经发生。' } } as ToolCallRecord;
    }
    return { ...call, status: 'interrupted', finishedAt,
      error: { code: 'INTERRUPTED', message: '工具调用随进程中断，未自动重新执行。' } } as ToolCallRecord;
  });
  run.approvals = run.approvals.map(approval => {
    if (approval.status !== 'pending') return approval;
    changed = true;
    return { ...approval, status: 'cancelled', decidedAt: Math.max(now, approval.createdAt) };
  });
  const pending = new Map<string, string>();
  for (const entry of run.transcript) {
    if (entry.message.role === 'assistant') for (const block of entry.message.content) {
      if (block.type === 'toolCall') pending.set(block.id, entry.turnId);
    }
    else if (entry.message.role === 'toolResult') pending.delete(entry.message.toolCallId);
  }
  for (const [id, turnId] of pending) {
    const call = run.toolCalls.find(item => item.toolCallId === id)!;
    if (!('error' in call)) throw new Error('Unresolved tool outcome');
    run.transcript = [...run.transcript, { sessionId: run.sessionId, runId: run.runId, turnId,
      messageId: randomUUID(), ordinal: run.transcript.length, message: {
        role: 'toolResult', toolCallId: id, toolName: call.toolName, isError: true,
        content: [{ type: 'text', text: `${call.error.code}: ${call.error.message}` }],
        details: { recovered: true, status: call.status }, timestamp: now,
      } }];
    changed = true;
  }
  return changed;
}
