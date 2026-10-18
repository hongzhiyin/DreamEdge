import { previewPaths } from '../files/preview.js';
import type { RunRecord } from './types.js';
import type { BatchRecoveryReference, BatchRecoveryScope } from '../tools/batch-types.js';
import { canonicalJson } from '../tools/json.js';
import { ConversationError } from './state.js';

/** Reconcile saved outcomes across all retries; never infer completion from a model's answer. */
export function batchRecovery(runs: readonly RunRecord[], reference: BatchRecoveryReference): BatchRecoveryScope {
  const selected = runs.find(run => run.runId === reference.sourceRunId);
  const receipt = selected?.approvals?.find(a => a.approvalId === reference.approvalId && a.batchPlan?.digest === reference.digest);
  if (!selected || !receipt?.batchPlan) throw new ConversationError('STALE_RUN', '批量计划已变化或不存在。');
  const root = selected.batchRecovery ?? { sourceRunId: reference.sourceRunId, approvalId: reference.approvalId, digest: reference.digest };
  const source = runs.find(run => run.runId === root.sourceRunId);
  const leader = source?.approvals?.find(a => a.approvalId === root.approvalId && a.batchPlan?.digest === root.digest);
  if (!source || !leader?.batchPlan || source.batchRecovery) throw new ConversationError('STALE_RUN', '恢复来源无效。');
  const related = runs.filter(run => run === source || (run.batchRecovery && canonicalJson(run.batchRecovery) === canonicalJson(root)));
  if (related.some(run => run.status === 'running' || run.status === 'cancelling')) throw new ConversationError('SESSION_BUSY', '批次尚未结算。');
  const items = leader.batchPlan.members.flatMap(member => {
    const original = source.toolCalls!.find(call => call.toolCallId === member.toolCallId)!;
    const attempts = related.flatMap(run => run.toolCalls ?? []).filter(call => call.toolName === member.toolName
      && call.argsDigest === member.argsDigest && call.preview?.path === member.path);
    if (attempts.some(call => call.status === 'outcome_unknown')) throw new ConversationError('RETRY_UNAVAILABLE', '批次包含结果未知的写入，请先核对实际文件，不能自动恢复。');
    if (attempts.some(call => call.status === 'succeeded')) return [];
    return [{ toolCallId: member.toolCallId, toolName: member.toolName, toolVersion: member.toolVersion,
      args: structuredClone(original.args), argsDigest: member.argsDigest, path: member.path, paths: previewPaths(original.preview!) }];
  });
  if (!items.length) throw new ConversationError('RETRY_UNAVAILABLE', '批次已完成，没有需要恢复的操作。');
  return { reference: structuredClone(root), items };
}
