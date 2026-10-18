import { recoverToolRun } from '../conversation/tool-recovery.js';
import { randomUUID } from 'node:crypto';
import type { ToolRunData } from './tool-contracts.js';
import type { ToolOutcome } from './tool-executor.js';
import type { ToolCallRecord } from '../tools/types.js';

/** A cancelled agent may omit message_end; host-owned settled receipts must remain truthful. */
export function sealToolOutcomes(data: ToolRunData, outcomes: ReadonlyMap<string, ToolOutcome>): void {
  for (const call of data.toolCalls) {
    const outcome = outcomes.get(call.toolCallId);
    if (!outcome || call.status !== 'running') continue;
    const record: ToolCallRecord = outcome.status === 'succeeded'
      ? { ...call, status: 'succeeded', startedAt: outcome.startedAt!, finishedAt: outcome.finishedAt, result: outcome.result }
      : { ...call, status: outcome.status, startedAt: outcome.startedAt, finishedAt: outcome.finishedAt, error: outcome.error! } as ToolCallRecord;
    data.toolCalls = data.toolCalls.map(c => c.toolCallId === call.toolCallId ? record : c);
    if (data.transcript.some(e => e.message.role === 'toolResult' && e.message.toolCallId === call.toolCallId)) continue;
    data.transcript = [...data.transcript, { sessionId: call.sessionId, runId: call.runId, turnId: call.turnId,
      messageId: randomUUID(), ordinal: data.transcript.length, message: { role: 'toolResult', toolCallId: call.toolCallId,
        toolName: call.toolName, content: [...outcome.result.content], details: outcome.result.details ?? {},
        isError: outcome.status !== 'succeeded', timestamp: outcome.finishedAt } }];
  }
}

/** Close pending call/result pairs before Pi's terminal cancellation message is appended. */
export function interruptToolData(data: ToolRunData, owner: { sessionId: string; runId: string },
  outcomes: ReadonlyMap<string, ToolOutcome>, invoked: ReadonlySet<string>): boolean {
  const pending = data.toolCalls.some(call => ['requested', 'awaiting_approval', 'authorized', 'running'].includes(call.status));
  const length = data.transcript.length;
  sealToolOutcomes(data, outcomes);
  data.toolCalls = data.toolCalls.map(call => call.status === 'running' && call.effect === 'write'
    && !invoked.has(call.toolCallId) ? { ...call, status: 'cancelled', finishedAt: Date.now(),
      error: { code: 'CANCELLED', message: '写操作尚未启动，运行已停止。' } } : call);
  const run = { ...data, sessionId: owner.sessionId, runId: owner.runId }; recoverToolRun(run, Date.now());
  Object.assign(data, { toolCalls: run.toolCalls, approvals: run.approvals, transcript: run.transcript });
  return pending || data.transcript.length !== length;
}
