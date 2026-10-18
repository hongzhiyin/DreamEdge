import { previewPaths } from '../files/preview.js';
import { containsPath } from '../files/scope-paths.js';
import type { ToolRunRecord } from '../runtime/tool-contracts.js';
import { batchDigest } from '../tools/batch-plan.js';
import { canonicalJson } from '../tools/json.js';
import { assertToolInspection } from '../tools/execution-policy.js';

function invalid(): never { throw new Error('Invalid batch authorization'); }
export function validateBatches(run: ToolRunRecord): void {
  const approvals = new Map(run.approvals.map(a => [a.approvalId, a]));
  for (const receipt of run.approvals) {
    if (!receipt.batch) { if (receipt.batchPlan) invalid(); continue; }
    const leader = approvals.get(receipt.batch.leaderApprovalId); const plan = leader?.batchPlan;
    if (!leader?.batch || !plan || plan.batchId !== receipt.batch.batchId || plan.digest !== receipt.batch.digest
      || canonicalJson(leader.batch) !== canonicalJson(receipt.batch)
      || (receipt !== leader && receipt.batchPlan) || leader.batch.leaderApprovalId !== leader.approvalId) invalid();
    if (receipt !== leader) continue;
    const { digest, ...base } = plan;
    if (batchDigest(base) !== digest || plan.sessionId !== run.sessionId || plan.runId !== run.runId
      || !Array.isArray(plan.members) || !plan.members.length || plan.members.length > 64
      || new Set(plan.members.map(m => m.path)).size !== plan.members.length
      || new Set(plan.members.map(m => m.toolCallId)).size !== plan.members.length) invalid();
    if (plan.members[0]!.toolCallId !== leader.toolCallId) invalid();
    if (leader.inspection?.rule !== 'file-batch/v1'
      || !['ask', 'allow'].includes(leader.inspection.decision)
      || (leader.inspection.decision === 'allow' && plan.members.some(member => member.inspection.decision !== 'allow'))) invalid();
    const group = run.approvals.filter(a => a.batch?.batchId === plan.batchId);
    if (group.length !== plan.members.length) invalid();
    for (let i = 0; i < plan.members.length; i++) for (const other of plan.members.slice(i + 1)) {
      if ((plan.members[i]!.paths ?? [plan.members[i]!.path]).some((a: string) => (other.paths ?? [other.path]).some((b: string) => containsPath(a, b) || containsPath(b, a)))) invalid();
    }
    for (const member of plan.members) {
      assertToolInspection(member.inspection);
      const call = run.toolCalls.find(c => c.toolCallId === member.toolCallId);
      const item = group.find(a => a.toolCallId === member.toolCallId);
      if (!call?.preview || !item || call.turnId !== plan.turnId || call.effect !== 'write' || call.approval !== 'always'
        || call.toolName !== member.toolName || call.toolVersion !== member.toolVersion || call.argsDigest !== member.argsDigest
        || canonicalJson(member.paths ?? [member.path]) !== canonicalJson(previewPaths(call.preview))
        || call.preview.path !== member.path || canonicalJson(member.file) !== canonicalJson(item.file)
        || item.status !== leader.status || item.createdAt !== leader.createdAt || item.expiresAt !== leader.expiresAt
        || ('decidedAt' in leader && (!('decidedAt' in item) || item.decidedAt !== leader.decidedAt))
        || canonicalJson(item.inspection) !== canonicalJson(leader.inspection) || member.inspection.decision === 'deny') invalid();
    }
  }
  for (const call of run.toolCalls) if (call.status === 'authorized') {
    if (approvals.get(call.approvalId)?.status !== 'approved' || !approvals.get(call.approvalId)?.batch) invalid();
  }
}
