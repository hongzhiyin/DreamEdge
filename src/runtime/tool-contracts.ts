import type { AssistantMessage, SystemMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import type { RunRecord } from '../conversation/types.js';
import type { ApprovalRecord, ToolCallIdentity, ToolCallRecord, ToolSnapshot } from '../tools/types.js';

export interface RunMessageRecord {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly ordinal: number;
  readonly message: SystemMessage | AssistantMessage | ToolResultMessage;
}

/** The host replaces ordered collections at durable boundaries; individual records remain immutable. */
export interface ToolRunData {
  toolsSnapshot: readonly ToolSnapshot[];
  transcript: readonly RunMessageRecord[];
  toolCalls: readonly ToolCallRecord[];
  approvals: readonly ApprovalRecord[];
}
export type ToolRunRecord = RunRecord & ToolRunData;

export interface ToolRuntimeOptions {
  readonly registry?: import('../tools/registry.js').ToolRegistry;
  readonly maxModelTurns?: number;
  readonly maxToolCalls?: number;
  readonly approvalTtlMs?: number;
}

interface EventIdentity { readonly sessionId: string; readonly runId: string; readonly sequence: number }
interface TurnIdentity { readonly turnId: string; readonly messageId: string }

/** Reserved for the tool runtime; the text runtime does not emit these events. */
export type ToolRuntimeEvent = EventIdentity & (
  | (TurnIdentity & { readonly type: 'message_started'; readonly role: 'assistant' | 'system' | 'toolResult' })
  | (TurnIdentity & { readonly type: 'message_delta'; readonly channel: 'text' | 'thinking'; readonly delta: string })
  | { readonly type: 'message_finished'; readonly record: RunMessageRecord }
  | { readonly type: 'tool_changed'; readonly call: ToolCallRecord }
  | { readonly type: 'approval_requested'; readonly approval: ApprovalRecord }
);

export interface ApprovalDecisionCommand extends ToolCallIdentity {
  readonly approvalId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly argsDigest: string;
  readonly decision: 'approve' | 'reject';
  readonly batchDigest?: string;
  readonly planDigest?: string;
  readonly policyVersion?: number;
}
