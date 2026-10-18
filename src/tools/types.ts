import type { BatchReference, FileBatchPlan } from './batch-types.js';
import type { ToolInspection } from './execution-policy.js';
import type { FilePreview } from '../files/preview.js';
import type { MutationReference } from '../files/mutation-types.js';
import type { Static, TSchema } from 'typebox';
import type { ImageContent, JsonObject, JsonValue, TextContent } from '@earendil-works/pi-ai';

export interface ToolMetadata {
  readonly origin?: import('./mcp-origin.js').McpToolOrigin;
  readonly name: string;
  readonly version: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly effect: 'read' | 'write';
  readonly approval: 'never' | 'always';
  readonly resources: readonly string[];
  readonly timeoutMs: number;
}

/** Serializable metadata only; callbacks and credentials cannot enter a run snapshot. */
export interface ToolSnapshot extends Omit<ToolMetadata, 'parameters'> {
  readonly parameters: Readonly<JsonObject>;
}

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  readonly approval?: { approvalId: string; expiresAt: number; file?: MutationReference };
  onUpdate?(result: ToolResult): void | Promise<void>;
}

export interface ToolResult {
  /** Host receipt; excluded from portable result copies. */
  readonly effectState?: 'committed' | 'unknown';
  /** Explicit remote error; does not establish absence of side effects. */
  readonly isError?: boolean;
  readonly content: readonly (TextContent | ImageContent)[];
  readonly details?: JsonValue;
}

export interface ToolDefinition<T extends TSchema = TSchema> extends Omit<ToolMetadata, 'parameters'> {
  readonly parameters: T;
  /** Wait for host-owned resources to settle after cancellation; not part of model metadata. */
  readonly awaitCancellation?: boolean;
  prepareApproval?(args: JsonObject, context: ToolExecutionContext): Promise<FilePreview>;
  inspectExecution?(args: JsonObject, context: ToolExecutionContext): Promise<ToolInspection>;
  release?(context: ToolExecutionContext): Promise<void>;
  execute(args: Static<T>, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolCallIdentity {
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly toolCallId: string;
}

export interface ToolFailure {
  readonly code: 'INVALID_ARGUMENTS' | 'UNKNOWN_TOOL' | 'DENIED' | 'TOOL_FAILED'
    | 'TIMEOUT' | 'CANCELLED' | 'INTERRUPTED' | 'OUTCOME_UNKNOWN';
  readonly message: string;
}

interface ToolCallBase extends ToolCallIdentity {
  readonly toolName: string;
  readonly toolVersion: string;
  readonly args: JsonObject;
  readonly argsDigest: string;
  readonly effect: ToolMetadata['effect'];
  readonly approval: ToolMetadata['approval'];
  readonly createdAt: number;
  readonly preview?: FilePreview;
  readonly retryOf?: { readonly runId: string; readonly toolCallId: string };
}

export type ToolCallRecord = ToolCallBase & (
  | { readonly status: 'requested' }
  | { readonly status: 'awaiting_approval' | 'authorized'; readonly approvalId: string }
  | { readonly status: 'running'; readonly startedAt: number; readonly approvalId?: string }
  | { readonly status: 'succeeded'; readonly startedAt: number; readonly finishedAt: number; readonly result: ToolResult }
  | { readonly status: 'failed'; readonly startedAt: number; readonly finishedAt: number; readonly error: ToolFailure }
  | { readonly status: 'rejected' | 'cancelled' | 'interrupted'; readonly startedAt?: number;
      readonly finishedAt: number; readonly error: ToolFailure }
  | { readonly status: 'outcome_unknown'; readonly startedAt: number; readonly finishedAt: number; readonly error: ToolFailure }
);
export type ToolCallStatus = ToolCallRecord['status'];

export interface ApprovalTarget extends ToolCallIdentity {
  readonly toolName: string;
  readonly toolVersion: string;
  readonly argsDigest: string;
}

interface ApprovalBase extends ApprovalTarget {
  readonly batch?: BatchReference;
  readonly batchPlan?: FileBatchPlan;
  /** Host inspection; allow receipts are policy decisions, not user consent. */
  readonly inspection?: ToolInspection;
  readonly approvalId: string;
  readonly file?: MutationReference;
  readonly summary: string;
  readonly resources: readonly string[];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type ApprovalRecord = ApprovalBase & (
  | { readonly status: 'pending' }
  | { readonly status: 'approved' | 'rejected' | 'expired' | 'cancelled'; readonly decidedAt: number }
);
