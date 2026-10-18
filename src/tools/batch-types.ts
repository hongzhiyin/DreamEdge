import type { MutationReference } from '../files/mutation-types.js';
import type { ToolInspection } from './execution-policy.js';
import type { JsonObject } from '@earendil-works/pi-ai';

export interface BatchMember {
  toolCallId: string; toolName: string; toolVersion: string; argsDigest: string;
  path: string; paths?: readonly string[]; file: MutationReference; inspection: ToolInspection;
}
export interface FileBatchPlan {
  batchId: string; sessionId: string; runId: string; turnId: string;
  members: readonly BatchMember[]; digest: string;
}
export interface BatchReference { batchId: string; digest: string; leaderApprovalId: string }
export interface BatchRecoveryReference { sourceRunId: string; approvalId: string; digest: string }
export interface BatchRecoveryItem {
  toolCallId: string; toolName: string; toolVersion: string; args: JsonObject; argsDigest: string; path: string; paths?: readonly string[];
}
export interface BatchRecoveryScope { reference: BatchRecoveryReference; items: readonly BatchRecoveryItem[] }
export interface ResumeBatchCommand extends BatchRecoveryReference { sessionId: string }
