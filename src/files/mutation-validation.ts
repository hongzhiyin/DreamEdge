import { validateOperationPreview } from './operation-validation.js';
import { isMutation } from './managed-tools.js';
import { isAbsolute, normalize } from 'node:path';
import type { MutationPreview } from './mutation-types.js';
import { mutationDigest } from './mutation-digest.js';
import type { ToolCallRecord, ApprovalRecord } from '../tools/types.js';
import { accountMutationVersion } from './mutation-policy.js';
import { mutationVersion } from './mutation-types.js';

export function validateMutationPreview(call: ToolCallRecord): void {
  const p = call.preview;
  if (!p) {
    if (isMutation(call.toolVersion) && ['awaiting_approval', 'authorized', 'running', 'succeeded', 'failed', 'outcome_unknown'].includes(call.status)) throw new Error('Missing mutation preview');
    return;
  }
  if (p.kind === 'file_operation') { validateOperationPreview(call, p); return; }
  const identity = (v: MutationPreview['parentIdentity']) => v && /^\d+$/.test(v.device) && /^\d+$/.test(v.inode);
  if (![mutationVersion, accountMutationVersion].includes(call.toolVersion) || call.effect !== 'write' || call.approval !== 'always'
    || !['write', 'edit'].includes(call.toolName) || p.kind !== 'file_mutation' || !p.planId
    || p.path !== p.binding?.path || !isAbsolute(p.path) || normalize(p.path) !== p.path
    || !['create', 'overwrite', 'edit'].includes(p.operation) || p.argsDigest !== call.argsDigest
    || !Number.isSafeInteger(p.policyVersion) || p.policyVersion !== p.binding.policyVersion
    || !['sessionId', 'runId', 'turnId', 'toolCallId'].every(key => p.binding[key as keyof typeof p.binding] === call[key as keyof ToolCallRecord])
    || p.binding.mode !== 'write' || !identity(p.parentIdentity) || !identity(p.binding.rootIdentity)
    || !/^[0-9a-f]{64}$/.test(p.afterSha256) || !Number.isSafeInteger(p.afterBytes) || p.afterBytes < 0 || p.afterBytes > 4 * 1024 * 1024
    || typeof p.patch !== 'string' || Buffer.byteLength(p.patch) > 128 * 1024 || !Number.isFinite(p.createdAt)
    || mutationDigest(p) !== p.planDigest) throw new Error('Invalid mutation preview');
  if (p.before.kind === 'present') {
    if (!p.before.dshVersion || !p.before.version || !['device', 'inode', 'size', 'modifiedNs', 'changedNs'].every(k => /^\d+$/.test(String(p.before.kind === 'present' ? p.before.version[k as keyof typeof p.before.version] : '')))
      || !/^[0-9a-f]{64}$/.test(p.before.version.sha256)) throw new Error('Invalid expected version');
  } else if (p.before.kind !== 'absent' || p.operation !== 'create') throw new Error('Invalid absent target');
}
export function validateMutationApproval(approval: ApprovalRecord, call: ToolCallRecord): void {
  if (!call.preview) { if (approval.file) throw new Error('Unexpected file authorization'); return; }
  if (!approval.file || approval.file.planId !== call.preview.planId || approval.file.planDigest !== call.preview.planDigest
    || approval.file.policyVersion !== call.preview.policyVersion) throw new Error('Mutation authorization mismatch');
}
