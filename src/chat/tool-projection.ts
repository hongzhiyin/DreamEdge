import { batchRecovery } from '../conversation/batch-recovery.js';
import type { RunRecord } from '../conversation/types.js';
import type { ChatToolCall, ChatTimelineItem } from './types.js';

/** Projects owned text and tool outcomes without provider internals or executable definitions. */
export function toolTimeline(run: RunRecord, runs: readonly RunRecord[] = [run]): ChatTimelineItem[] {
  const calls = new Map<string, ChatToolCall>((run.toolCalls ?? []).map(call => {
    const definition = run.toolsSnapshot?.find(tool => tool.name === call.toolName);
    const returned = run.transcript?.find(entry => entry.message.role === 'toolResult' && entry.message.toolCallId === call.toolCallId)?.message;
    const result = call.status === 'succeeded' ? call.result : returned?.role === 'toolResult'
      ? { content: returned.content, ...(returned.details === undefined ? {} : { details: returned.details }) } : undefined;
    const approval = run.approvals?.find(item => item.toolCallId === call.toolCallId);
    return [call.toolCallId, { toolCallId: call.toolCallId, label: definition?.label ?? call.toolName,
      ...(definition?.origin ? { origin: structuredClone(definition.origin) } : {}),
      name: call.toolName, version: call.toolVersion, status: call.status, effect: call.effect, args: structuredClone(call.args),
      resources: [...(approval?.resources ?? definition?.resources ?? [])],
      ...(call.preview ? { preview: structuredClone(call.preview) } : {}),
      ...(approval ? { approval: structuredClone(approval) } : {}),
      ...('error' in call ? { error: call.error.message } : {}),
      ...(result ? { result: structuredClone(result) } : {}) }];
  }));
  for (const call of calls.values()) {
    const plan = call.approval?.batchPlan;
    if (!plan) continue;
    call.batchItems = plan.members.map(member => {
      const target = calls.get(member.toolCallId)!;
      return { toolCallId: member.toolCallId, status: target.status, preview: target.preview!, reason: member.inspection.reason,
        ...(target.error ? { error: target.error } : {}) };
    });
    if (!['running', 'cancelling'].includes(run.status) && call.batchItems.some(item => item.status !== 'succeeded')) {
      const reference = { sourceRunId: run.runId, approvalId: call.approval!.approvalId, digest: plan.digest };
      try { call.batchRecovery = { reference, remaining: batchRecovery(runs, reference).items.length }; }
      catch (error) { call.batchRecovery = { reference, remaining: 0, unavailable: (error as Error).message }; }
    }
  }
  const timeline: ChatTimelineItem[] = [];
  for (const entry of run.transcript ?? []) {
    if (entry.message.role !== 'assistant') continue;
    const text = entry.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    const partial = entry.messageId === run.currentMessageId && !text && Boolean(run.text)
      && ['error', 'aborted'].includes(entry.message.stopReason);
    timeline.push({ kind: 'model', messageId: entry.messageId, turnId: entry.turnId,
      text: partial ? run.text : text,
      thinking: partial ? run.thinking : entry.message.content.filter(block => block.type === 'thinking').map(block => block.thinking).join('') });
    for (const block of entry.message.content) if (block.type === 'toolCall') {
      const call = calls.get(block.id); if (call) timeline.push({ kind: 'tool', call });
    }
  }
  if (run.currentMessageId && run.currentTurnId && !timeline.some(item => item.kind === 'model' && item.messageId === run.currentMessageId)) {
    timeline.push({ kind: 'model', messageId: run.currentMessageId, turnId: run.currentTurnId,
      text: run.text, thinking: run.thinking });
  }
  return timeline;
}
