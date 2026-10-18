import type { FileScopeState, DirectoryPicker, DeviceAccessPolicy } from '../files/scope-types.js';
import type { AssistantMessage, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { AgentRuntime, ModelConnectionConfig, RuntimeFailure, ThinkingLevel } from '../model/types.js';
import type { SaveState, SessionStore } from '../storage/types.js';
import type { ApprovalDecisionCommand, RunMessageRecord } from '../runtime/tool-contracts.js';
import type { ApprovalRecord, ToolCallRecord, ToolSnapshot } from '../tools/types.js';

export type RunStatus = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted';

export interface SessionRecord {
  sessionId: string;
  title: string;
  connectionId: string;
  systemPrompt?: string;
  toolsDisabled?: true;
  externalTools?: true;
  createdAt: number;
  updatedAt: number;
  version: number;
  fileScope?: FileScopeState;
}

export interface MessageRecord {
  messageId: string;
  sessionId: string;
  clientMessageId: string;
  role: 'user';
  content: string;
  timestamp: number;
  requestedThinkingLevel?: ThinkingLevel;
}

/** Each attempt owns its assistant response; retries reuse the user message. */
export interface RunRecord {
  batchRecovery?: import('../tools/batch-types.js').BatchRecoveryReference;
  runId: string;
  sessionId: string;
  userMessageId: string;
  modelConfigSnapshot: ModelConnectionConfig;
  status: RunStatus;
  text: string;
  thinking: string;
  currentMessageId?: string;
  currentTurnId?: string;
  thinkingLevel?: ModelThinkingLevel;
  notices: string[];
  lastEventSequence: number;
  createdAt: number;
  finishedAt?: number;
  stopReason?: string;
  nativeMessage?: AssistantMessage;
  toolsSnapshot?: readonly ToolSnapshot[];
  transcript?: readonly RunMessageRecord[];
  toolCalls?: readonly ToolCallRecord[];
  approvals?: readonly ApprovalRecord[];
  error?: RuntimeFailure;
}

export interface ConversationSnapshot {
  session: SessionRecord;
  messages: MessageRecord[];
  runs: RunRecord[];
  activeRunId?: string;
  saveState: SaveState;
  acceptingCommands: boolean;
}

export interface CreateSessionInput {
  connectionId: string;
  title?: string;
  systemPrompt?: string;
  toolsDisabled?: true;
  externalTools?: true;
}

export interface SendMessageInput {
  sessionId: string;
  clientMessageId: string;
  text: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ConversationHandle {
  readonly sessionId: string;
  readonly userMessageId: string;
  readonly runId: string;
  cancel(): void;
  decideApproval?(command: ApprovalDecisionCommand): boolean;
  /** Resolves after the runtime settles and the session record is updated. */
  readonly done: Promise<RunRecord>;
}

export interface ConversationDependencies {
  prepareTools?: import('./prepared-tools.js').PrepareRunTools;
  guardModelContext?(sessionId: string, config: ModelConnectionConfig): void;

  connection(connectionId: string): ModelConnectionConfig;
  runtime(connection: ModelConnectionConfig): AgentRuntime;
  tools?(connection: ModelConnectionConfig, sessionId?: string): readonly ToolSnapshot[];
  now?: () => number;
  store?: SessionStore;
  checkpointMs?: number;
  directoryPicker?: DirectoryPicker;
  deviceAccess?(connection: ModelConnectionConfig): DeviceAccessPolicy | undefined;
}
