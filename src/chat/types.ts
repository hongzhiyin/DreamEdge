import type { FilePreview } from '../files/preview.js';
import type { FileScopeGrant, FileScopeState, FileGrantOptions, FileScopeOverview } from '../files/scope-types.js';
import type { ThinkingLevel } from '../model/types.js';
import type { RunStatus } from '../conversation/types.js';
import type { SaveState } from '../storage/types.js';
import type { ApprovalDecisionCommand } from '../runtime/tool-contracts.js';
import type { ApprovalRecord, ToolCallStatus, ToolResult } from '../tools/types.js';
import type { JsonObject } from '@earendil-works/pi-ai';

export interface ChatToolCall {
  origin?: import('../tools/mcp-origin.js').McpToolOrigin;
  batchItems?: { toolCallId: string; status: ToolCallStatus; preview: FilePreview; reason: string; error?: string }[];
  batchRecovery?: { reference: import('../tools/batch-types.js').BatchRecoveryReference; remaining: number; unavailable?: string };
  toolCallId: string; label: string; name: string; version: string; status: ToolCallStatus;
  effect: 'read' | 'write'; args: JsonObject; resources: string[]; approval?: ApprovalRecord; preview?: FilePreview;
  result?: ToolResult; error?: string;
}
export type ChatTimelineItem = { kind: 'model'; messageId: string; turnId: string; text: string; thinking: string }
  | { kind: 'tool'; call: ChatToolCall };

export interface ChatSession { sessionId: string; title: string; updatedAt: number }
export interface ChatAttempt {
  runId: string; status: RunStatus; text: string; thinking: string; model: string;
  thinkingLevel?: string; error?: string;
  approvals?: ApprovalRecord[];
  timeline?: ChatTimelineItem[];
  retryBlocked?: boolean;
  canRetryRead?: boolean;
}
export interface ChatMessage {
  messageId: string; clientMessageId: string; text: string; attempts: ChatAttempt[];
}
export interface ChatView extends ChatSession {
  externalContext?: 'reference-only' | 'mcp-read';
  fileScope?: FileScopeOverview;
  messages: ChatMessage[];
  activeRunId?: string;
  acceptingCommands: boolean;
  saving: { status: SaveState['status']; error?: string };
}
export interface ChatConnection { model: string; levels: ThinkingLevel[]; defaultLevel: ThinkingLevel }
export interface ChatBootstrap { sessions: ChatSession[]; connection: ChatConnection }
export interface ChatCursor { epoch: string; sequence: number }
export interface ChatEvent extends ChatCursor { sessionId: string; view: ChatView }
export type ChatCatchup = { kind: 'snapshot'; event: ChatEvent } | { kind: 'replay'; events: ChatEvent[] };
export interface ChatAck { runId: string; userMessageId: string }
export interface ChatSend { sessionId: string; clientMessageId: string; text: string; thinkingLevel?: ThinkingLevel }
export interface ChatBridge {
  resumeBatch?(reference: import('../tools/batch-types.js').ResumeBatchCommand): Promise<ChatAck>;
  fileScopes?(sessionId: string): Promise<FileScopeState>;
  chooseDirectory?(sessionId: string, options: FileGrantOptions): Promise<FileScopeGrant | undefined>;
  revokeDirectory?(sessionId: string, grantId: string): Promise<void>;
  setDeviceAccess?(sessionId: string, enabled: boolean): Promise<boolean>;
  initialize(): Promise<ChatBootstrap>;
  createSession(): Promise<ChatSession>;
  watch(sessionId: string, cursor?: ChatCursor): Promise<ChatCatchup>;
  send(input: ChatSend): Promise<ChatAck>;
  stop(sessionId: string, runId: string): Promise<void>;
  retry(sessionId: string, runId: string, mode?: 'continue' | 'read_tools'): Promise<ChatAck>;
  decideApproval?(decision: ApprovalDecisionCommand): Promise<void>;
  retrySave(sessionId: string): Promise<void>;
  subscribe(listener: (event: ChatEvent) => void): () => void;
  onVisible(listener: () => void): () => void;
}
export type ChatCommand = { type: 'initialize' | 'create' }
  | { type: 'watch'; sessionId: string; cursor?: ChatCursor }
  | { type: 'send'; input: ChatSend }
  | { type: 'stop'; sessionId: string; runId: string }
  | { type: 'retry'; sessionId: string; runId: string; mode?: 'continue' | 'read_tools' }
  | { type: 'resumeBatch'; reference: import('../tools/batch-types.js').ResumeBatchCommand }
  | { type: 'approval'; decision: ApprovalDecisionCommand }
  | { type: 'retrySave'; sessionId: string };
export type ChatReply<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
