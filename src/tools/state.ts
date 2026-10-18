import { ToolContractError } from './errors.js';
import type { ApprovalRecord, ApprovalTarget, ToolCallRecord, ToolCallStatus } from './types.js';

const transitions: Record<ToolCallStatus, readonly ToolCallStatus[]> = {
  requested: ['awaiting_approval', 'running', 'rejected', 'cancelled', 'interrupted'],
  awaiting_approval: ['authorized', 'running', 'rejected', 'cancelled', 'interrupted'],
  authorized: ['running', 'rejected', 'cancelled', 'interrupted'],
  running: ['succeeded', 'failed', 'cancelled', 'interrupted', 'outcome_unknown'],
  succeeded: [], failed: [], rejected: [], cancelled: [], interrupted: [], outcome_unknown: [],
};

/** Checks lifecycle grammar only; authorization and durable writes belong to the executor. */
export function assertToolTransition(call: ToolCallRecord, next: ToolCallStatus): void {
  if (!transitions[call.status]?.includes(next)
    || (call.status === 'requested' && call.approval === 'always' && next === 'running')
    || (call.effect === 'write' && call.status === 'running' && next === 'interrupted')
    || (call.effect === 'read' && next === 'outcome_unknown')) {
    throw new ToolContractError('INVALID_TOOL_STATE', '工具调用状态不能按该路径变更。');
  }
}

/** Matching is not authorization: the host must also check the active run and call state. */
export function isPendingApprovalFor(approval: ApprovalRecord, target: ApprovalTarget, now: number): boolean {
  return approval.status === 'pending' && Number.isFinite(now) && Number.isFinite(approval.createdAt)
    && Number.isFinite(approval.expiresAt) && approval.expiresAt > approval.createdAt && now >= approval.createdAt
    && now < approval.expiresAt && ['sessionId', 'runId', 'turnId', 'toolCallId', 'toolName', 'toolVersion', 'argsDigest']
      .every(key => approval[key as keyof ApprovalTarget] === target[key as keyof ApprovalTarget]);
}
