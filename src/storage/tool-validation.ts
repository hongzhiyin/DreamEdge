import { validateBatches } from './batch-validation.js';
import { validateMutationPreview, validateMutationApproval } from '../files/mutation-validation.js';
import { validateFileResult } from '../files/file-result-validation.js';
import type { ToolCallRecord, ApprovalRecord } from '../tools/types.js';
import type { ToolRunRecord } from '../runtime/tool-contracts.js';
import { argumentsDigest, canonicalJson } from '../tools/json.js';
import { toolSetSnapshot } from '../tools/snapshot.js';
import { validateToolArguments } from '../tools/schema.js';
import { assertRunTranscript } from '../runtime/transcript-contract.js';
import { hasRunData } from '../conversation/run-data.js';
import type { RunRecord } from '../conversation/types.js';
import { SessionStoreError } from './types.js';
import { assertToolInspection } from '../tools/execution-policy.js';

export function invalidToolData(): never { throw new SessionStoreError('INVALID_DATA', '工具运行记录无效。'); }
const text = (value: unknown) => typeof value === 'string' && Boolean(value.trim());
const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

export function validateToolData(run: RunRecord): void {
  const fields = [run.toolsSnapshot, run.transcript, run.toolCalls, run.approvals];
  if (fields.every(value => value === undefined)) return;
  if (!hasRunData(run)) invalidToolData();
  const names = new Map(run.toolsSnapshot.map(tool => [tool.name, tool]));
  const snapshots = toolSetSnapshot(run.toolsSnapshot, [...names.keys()], run.modelConfigSnapshot,
    (run.thinkingLevel ?? run.modelConfigSnapshot.thinkingLevel ?? 'off') as 'off' | 'high');
  if (canonicalJson(snapshots) !== canonicalJson(run.toolsSnapshot)) invalidToolData();
  if (names.size !== run.toolsSnapshot.length) invalidToolData();
  assertRunTranscript(run.transcript, run, run.status === 'completed');
  const requests = new Map<string, { turnId: string; name: string; args: unknown }>();
  const results = new Map<string, { isError: boolean; content: unknown; details?: unknown }>();
  for (const entry of run.transcript) {
    if (entry.message.role === 'assistant') for (const block of entry.message.content) {
      if (block.type === 'toolCall') requests.set(block.id, { turnId: entry.turnId, name: block.name, args: block.arguments });
    }
    else if (entry.message.role === 'toolResult') results.set(entry.message.toolCallId, entry.message);
  }
  const calls = new Map<string, ToolCallRecord>();
  for (const call of run.toolCalls) {
    validateMutationPreview(call);
    const request = requests.get(call.toolCallId);
    const tool = names.get(call.toolName);
    if (!request || calls.has(call.toolCallId) || call.sessionId !== run.sessionId || call.runId !== run.runId
      || call.turnId !== request.turnId || call.toolName !== request.name || !text(call.toolVersion)
      || argumentsDigest(call.args) !== call.argsDigest || canonicalJson(call.args) !== canonicalJson(request.args)
      || !time(call.createdAt) || !['read', 'write'].includes(call.effect) || !['never', 'always'].includes(call.approval)
      || (call.effect === 'write' && call.approval !== 'always')) invalidToolData();
    if (tool && (tool.version !== call.toolVersion || tool.effect !== call.effect || tool.approval !== call.approval)) invalidToolData();
    if (call.status !== 'rejected' && !tool) invalidToolData();
    if (['running', 'succeeded', 'failed', 'outcome_unknown'].includes(call.status)) {
      if (!('startedAt' in call) || !time(call.startedAt) || call.startedAt < call.createdAt) invalidToolData();
      validateToolArguments(tool!, call.args);
    }
    if (!['requested', 'awaiting_approval', 'authorized', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'interrupted', 'outcome_unknown'].includes(call.status)) invalidToolData();
    if ('finishedAt' in call && (!time(call.finishedAt) || call.finishedAt < call.createdAt
      || ('startedAt' in call && call.startedAt !== undefined && call.finishedAt < call.startedAt))) invalidToolData();
    if (!['requested', 'awaiting_approval', 'authorized', 'running'].includes(call.status) && !('finishedAt' in call)) invalidToolData();
    const result = results.get(call.toolCallId);
    if (call.status === 'succeeded') {
      validateFileResult(call, run.modelConfigSnapshot);
      validateToolArguments(tool!, call.args);
      if (!result || result.isError || canonicalJson(result.content) !== canonicalJson(call.result.content)
        || canonicalJson(result.details ?? null) !== canonicalJson(call.result.details ?? null)) invalidToolData();
    } else if (['failed', 'rejected', 'cancelled', 'interrupted', 'outcome_unknown'].includes(call.status)) {
      if (!('error' in call) || !['INVALID_ARGUMENTS', 'UNKNOWN_TOOL', 'DENIED', 'TOOL_FAILED', 'TIMEOUT',
        'CANCELLED', 'INTERRUPTED', 'OUTCOME_UNKNOWN'].includes(call.error.code)
        || !text(call.error.message) || !('finishedAt' in call)) invalidToolData();
      if (result && !result.isError) invalidToolData();
      if (call.status === 'outcome_unknown' && (call.effect !== 'write' || call.error.code !== 'OUTCOME_UNKNOWN')) invalidToolData();
    } else if (result) invalidToolData();
    calls.set(call.toolCallId, call);
  }
  if (requests.size !== calls.size) invalidToolData();
  validateApprovals(run, calls);
  validateBatches(run);
  if (run.status === 'completed') {
    const final = run.transcript.at(-1)?.message;
    if (final?.role !== 'assistant' || final.stopReason !== 'stop'
      || run.toolCalls.some(call => ['requested', 'awaiting_approval', 'authorized', 'running'].includes(call.status))) invalidToolData();
    if (run.text !== final.content.filter(block => block.type === 'text').map(block => block.text).join('')) invalidToolData();
    if (run.nativeMessage && JSON.stringify(run.nativeMessage) !== JSON.stringify(final)) invalidToolData();
  }
}

function validateApprovals(run: ToolRunRecord, calls: Map<string, ToolCallRecord>): void {
  const ids = new Map<string, ApprovalRecord>();
  for (const approval of run.approvals) {
    if (approval.inspection) {
      assertToolInspection(approval.inspection);
      if (approval.inspection.decision === 'deny') invalidToolData();
    }
    const call = calls.get(approval.toolCallId);
    if (call) validateMutationApproval(approval, call);
    if (!call || !text(approval.approvalId) || ids.has(approval.approvalId) || !text(approval.summary)
      || (['sessionId', 'runId', 'turnId', 'toolName', 'toolVersion', 'argsDigest'] as const).some(key => approval[key] !== call[key])
      || !time(approval.createdAt) || !time(approval.expiresAt) || approval.expiresAt <= approval.createdAt
      || !Array.isArray(approval.resources) || approval.resources.some(resource => !text(resource))) invalidToolData();
    if (!['pending', 'approved', 'rejected', 'expired', 'cancelled'].includes(approval.status)) invalidToolData();
    if (approval.status !== 'pending' && (!time(approval.decidedAt) || approval.decidedAt < approval.createdAt)) invalidToolData();
    if (approval.status === 'approved' && approval.decidedAt >= approval.expiresAt) invalidToolData();
    ids.set(approval.approvalId, approval);
  }
  for (const call of calls.values()) {
    if (call.status === 'awaiting_approval' && ids.get(call.approvalId)?.status !== 'pending') invalidToolData();
    if (['authorized', 'running', 'succeeded', 'failed', 'outcome_unknown'].includes(call.status) && call.approval === 'always'
      && ![...ids.values()].some(approval => approval.toolCallId === call.toolCallId && approval.status === 'approved')) invalidToolData();
  }
}
