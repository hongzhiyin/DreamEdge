import { previewPaths } from '../files/preview.js';
import { randomUUID } from 'node:crypto';
import type { ApprovalDecisionCommand, ToolRunData } from './tool-contracts.js';
import type { ApprovalRecord, ToolCallRecord, ToolSnapshot } from '../tools/types.js';
import { isPendingApprovalFor } from '../tools/state.js';
import type { ToolInspection } from '../tools/execution-policy.js';
import type { FileBatchPlan } from '../tools/batch-types.js';
import type { PreparedTool } from './tool-preparation.js';

type Decision = 'approve' | 'reject' | 'expired' | 'cancelled';
const matches = (approval: ApprovalRecord, command: ApprovalDecisionCommand) =>
  (['sessionId', 'runId', 'turnId', 'toolCallId', 'toolName', 'toolVersion', 'argsDigest', 'approvalId'] as const)
    .every(key => approval[key] === command[key])
    && (!approval.batch || approval.batch.digest === command.batchDigest)
    && (!approval.file || (approval.file.planDigest === command.planDigest && approval.file.policyVersion === command.policyVersion));

/** Receipts authorize one immutable call; decisions never execute a callback directly. */
export class ToolApprovals {
  private waiting: { approval: ApprovalRecord; decision?: Decision; resolve: (decision: Decision) => void } | undefined;

  constructor(private readonly data: ToolRunData, private readonly signal: AbortSignal,
    private readonly commit: () => Promise<void>, private readonly ttlMs: number) {}

  decide(command: ApprovalDecisionCommand): boolean {
    if (this.signal.aborted || !['approve', 'reject'].includes(command.decision)) return false;
    const receipt = this.data.approvals.find(item => item.approvalId === command.approvalId);
    if (!receipt || receipt.inspection?.decision === 'allow' || !matches(receipt, command)
      || (receipt.batch && receipt.batch.leaderApprovalId !== receipt.approvalId)) return false;
    if (receipt.status !== 'pending') return receipt.status === (command.decision === 'approve' ? 'approved' : 'rejected');
    const waiting = this.waiting;
    if (!waiting || waiting.approval.approvalId !== receipt.approvalId
      || !isPendingApprovalFor(receipt, command, Date.now())) return false;
    if (waiting.decision) return waiting.decision === command.decision;
    waiting.decision = command.decision; waiting.resolve(command.decision); return true;
  }

  authorized(call: ToolCallRecord): boolean {
    return call.approval === 'never' || (['running', 'authorized'].includes(call.status) && this.data.approvals.some(receipt =>
      receipt.status === 'approved' && receipt.toolCallId === call.toolCallId
      && matches(receipt, { ...call, approvalId: receipt.approvalId, decision: 'approve',
        ...(receipt.batch ? { batchDigest: receipt.batch.digest } : {}),
        ...(call.preview ? { planDigest: call.preview.planDigest, policyVersion: call.preview.policyVersion } : {}) })));
  }

  receipt(call: ToolCallRecord): ApprovalRecord | undefined {
    return this.data.approvals.find(receipt => receipt.status === 'approved' && receipt.toolCallId === call.toolCallId);
  }

  async permitBatch(prepared: readonly PreparedTool[], plan: FileBatchPlan, forceConfirmation: boolean): Promise<boolean> {
    const createdAt = Date.now(); const leaderApprovalId = randomUUID();
    const ask = forceConfirmation || prepared.some(item => item.inspection?.decision === 'ask');
    const inspection: ToolInspection = { decision: ask ? 'ask' : 'allow', rule: 'file-batch/v1',
      reason: forceConfirmation ? '恢复未完成操作，需要核对本次预览。' : `已核对 ${prepared.length} 项文件变更。` };
    const receipts: ApprovalRecord[] = prepared.map(({ call }, index) => ({
      sessionId: call.sessionId, runId: call.runId, turnId: call.turnId, toolCallId: call.toolCallId,
      toolName: call.toolName, toolVersion: call.toolVersion, argsDigest: call.argsDigest,
      approvalId: index === 0 ? leaderApprovalId : randomUUID(), inspection,
      batch: { batchId: plan.batchId, digest: plan.digest, leaderApprovalId }, ...(index === 0 ? { batchPlan: plan } : {}),
      file: plan.members[index]!.file, summary: `${prepared.length} 项文件变更`, resources: previewPaths(call.preview!).map(path => `filesystem:${path}`),
      status: 'pending', createdAt, expiresAt: createdAt + this.ttlMs,
    }));
    const leader = receipts[0]!; let resolve!: (value: Decision) => void;
    const decision = new Promise<Decision>(done => { resolve = done; });
    if (ask) this.waiting = { approval: leader, resolve };
    const cancel = () => resolve('cancelled'); this.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => resolve('expired'), this.ttlMs);
    try {
      this.data.approvals = [...this.data.approvals, ...receipts];
      prepared.forEach(({ call }, index) => this.replace({ ...call, status: 'awaiting_approval', approvalId: receipts[index]!.approvalId }));
      await this.commit(); if (this.signal.aborted) cancel();
      let answer: Decision = ask ? await decision : 'approve';
      if (this.signal.aborted) answer = 'cancelled';
      else if (Date.now() >= leader.expiresAt) answer = 'expired';
      const decidedAt = Date.now();
      this.data.approvals = this.data.approvals.map(receipt => receipt.batch?.batchId === plan.batchId
        ? { ...receipt, status: answer === 'approve' ? 'approved' : answer === 'reject' ? 'rejected' : answer, decidedAt } : receipt);
      prepared.forEach(({ call }, index) => this.replace(answer === 'approve'
        ? { ...call, status: 'authorized', approvalId: receipts[index]!.approvalId }
        : { ...call, status: answer === 'cancelled' ? 'cancelled' : 'rejected', finishedAt: decidedAt,
          error: { code: answer === 'cancelled' ? 'CANCELLED' : 'DENIED', message: '批量计划未获执行许可。' } }));
      if (!this.signal.aborted) await this.commit();
      return answer === 'approve' && !this.signal.aborted;
    } finally { clearTimeout(timer); this.signal.removeEventListener('abort', cancel); this.waiting = undefined; }
  }

  async permit(call: ToolCallRecord, snapshot: ToolSnapshot, inspection?: ToolInspection): Promise<boolean> {
    if (inspection?.decision === 'deny') return false;
    const createdAt = Date.now();
    const approval: ApprovalRecord = { sessionId: call.sessionId, runId: call.runId, turnId: call.turnId,
      toolCallId: call.toolCallId, toolName: call.toolName, toolVersion: call.toolVersion, argsDigest: call.argsDigest,
      approvalId: randomUUID(), summary: call.preview ? `${call.preview.operation} ${call.preview.path}` : snapshot.label,
      resources: call.preview ? previewPaths(call.preview).map(path => `filesystem:${path}`) : [...snapshot.resources],
      ...(inspection ? { inspection } : {}),
      ...(call.preview ? { file: { planId: call.preview.planId, planDigest: call.preview.planDigest, policyVersion: call.preview.policyVersion } } : {}),
      status: 'pending', createdAt, expiresAt: createdAt + this.ttlMs };
    let resolve!: (decision: Decision) => void;
    const decision = new Promise<Decision>(done => { resolve = done; });
    if (inspection?.decision !== 'allow') this.waiting = { approval, resolve };
    const cancel = () => resolve('cancelled');
    this.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => resolve('expired'), this.ttlMs);
    try {
      this.data.approvals = [...this.data.approvals, approval];
      this.replace({ ...call, status: 'awaiting_approval', approvalId: approval.approvalId });
      await this.commit();
      if (this.signal.aborted) cancel();
      let answer: Decision = inspection?.decision === 'allow' ? 'approve' : await decision;
      if (this.signal.aborted) answer = 'cancelled';
      else if (Date.now() >= approval.expiresAt) answer = 'expired';
      const decidedAt = Date.now();
      this.data.approvals = this.data.approvals.map(item => item.approvalId === approval.approvalId
        ? { ...item, status: answer === 'approve' ? 'approved' : answer === 'reject' ? 'rejected' : answer, decidedAt } : item);
      if (answer === 'approve') this.replace({ ...call, status: 'running', approvalId: approval.approvalId, startedAt: decidedAt });
      else this.replace({ ...call, status: answer === 'cancelled' ? 'cancelled' : 'rejected', finishedAt: decidedAt,
        error: { code: answer === 'cancelled' ? 'CANCELLED' : 'DENIED',
          message: answer === 'cancelled' ? '工具调用已取消。' : answer === 'expired' ? '工具授权已过期。' : '工具调用被拒绝。' } });
      if (!this.signal.aborted) await this.commit();
      return answer === 'approve' && !this.signal.aborted;
    } finally {
      clearTimeout(timer); this.signal.removeEventListener('abort', cancel); this.waiting = undefined;
    }
  }

  private replace(call: ToolCallRecord): void {
    this.data.toolCalls = this.data.toolCalls.map(old => old.toolCallId === call.toolCallId ? call : old);
  }
}
