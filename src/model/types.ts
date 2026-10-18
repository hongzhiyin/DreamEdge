import type { Message, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { ToolSnapshot } from '../tools/types.js';
import type { ApprovalDecisionCommand, ToolRunData } from '../runtime/tool-contracts.js';

export const protocols = [
  'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai',
] as const;
export type ModelProtocol = typeof protocols[number];
export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high'] as const;
export type ThinkingLevel = typeof thinkingLevels[number];
export type ThinkingFormat = 'openai' | 'deepseek' | 'openrouter' | 'zai' | 'qwen';
export type ToolCallingCapability = { supported: false }
  | { supported: true; supportedThinkingLevels: ThinkingLevel[] };

export interface ModelConnectionConfig {
  id: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  credentialRef: string;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
  toolCalling?: ToolCallingCapability;
  reasoning?: {
    supportedLevels: ThinkingLevel[];
    effortMap?: ThinkingLevelMap;
    format?: ThinkingFormat;
  };
}

export type CredentialResolver = (reference: string, signal: AbortSignal) => Promise<string | undefined>;
export interface RuntimeRequest {
  batchRecovery?: import('../tools/batch-types.js').BatchRecoveryScope;
  sessionId: string;
  runId: string;
  /** Includes the final user input exactly once; the runtime calls Agent.continue(). */
  messages: readonly Message[];
  thinkingLevel?: ThinkingLevel;
  /** Metadata snapshot; executing it requires the tool runtime integration. */
  tools?: readonly ToolSnapshot[];
  /** Resume an existing question from a complete tool-result tail, without adding another user message. */
  continuation?: boolean;
  /** Host enables approvals only when a durable session store is available. */
  approvalsEnabled?: boolean;
  /** Host-only durable boundary; never serialized or sent to the provider. */
  beforeModelRequest?(messages: readonly Message[], signal: AbortSignal): void | Promise<void>;
  checkpoint?(data: ToolRunData, signal: AbortSignal): Promise<boolean>;
}

export interface RuntimeFailure {
  code: 'INVALID_CONFIG' | 'MISSING_CREDENTIAL' | 'CREDENTIAL_ACCESS_FAILED'
    | 'UNSUPPORTED_THINKING' | 'TOOLS_NOT_ENABLED' | 'INVALID_CONTEXT' | 'REQUEST_FAILED'
    | 'OUTPUT_LIMIT' | 'RUN_LIMIT' | 'UNEXPECTED_RESPONSE' | 'REQUEST_TIMEOUT' | 'EVENT_DELIVERY_FAILED' | 'OUTCOME_UNKNOWN';
  message: string;
}

export interface RuntimeResult {
  sessionId: string;
  runId: string;
  status: 'completed' | 'cancelled' | 'failed';
  text: string;
  stopReason?: string;
  thinkingLevel?: ModelThinkingLevel;
  /** Full native message for later persistence/replay, including reasoning metadata. */
  message?: Extract<Message, { role: 'assistant' }>;
  error?: RuntimeFailure;
  toolData?: ToolRunData;
}

interface EventIdentity { sessionId: string; runId: string; sequence: number }
export type RuntimeEvent = EventIdentity & (
  | { type: 'started'; connectionId: string; model: string; thinkingLevel: ThinkingLevel; notices: string[] }
  | { type: 'delta'; channel: 'text' | 'thinking'; delta: string }
  | { type: 'settled'; result: RuntimeResult }
  | { type: 'message_started'; turnId: string; messageId: string; role: 'assistant' }
);
export type RuntimeObserver = (event: RuntimeEvent, signal: AbortSignal) => void | Promise<void>;
export interface RuntimeHandle {
  cancel(): void;
  decideApproval?(command: ApprovalDecisionCommand): boolean;
  /** Settles after the provider run and all awaited observers, including the final event. */
  done: Promise<RuntimeResult>;
}
export interface AgentRuntime {
  start(request: RuntimeRequest, observer?: RuntimeObserver): RuntimeHandle;
}
