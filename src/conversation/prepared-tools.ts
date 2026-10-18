import type { AgentRuntime, ModelConnectionConfig } from '../model/types.js';
import type { ToolExecutionContext, ToolSnapshot } from '../tools/types.js';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { ConversationDependencies, RunRecord } from './types.js';
import type { SessionState } from './state.js';
import type { SessionPersistence } from './persistence.js';
import { argumentsDigest, canonicalJson } from '../tools/json.js';
import { toolSetSnapshot } from '../tools/snapshot.js';
import { touch } from './state.js';
import { abortable } from '../model/errors.js';

export interface RunToolPreparation {
  readonly sessionId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly tools: readonly ToolSnapshot[];
  authorize(snapshot: ToolSnapshot, args: JsonObject, context: ToolExecutionContext): boolean;
}
export interface PreparedRunTools { readonly tools: readonly ToolSnapshot[]; readonly runtime: AgentRuntime }
export interface PrepareRunTools {
  (config: ModelConnectionConfig, context: RunToolPreparation): Promise<PreparedRunTools>;
  /** Synchronous and network-free check before each model request, including text-only recovery. */
  guardHistory?(runs: readonly RunRecord[], config: ModelConnectionConfig, current: ModelConnectionConfig): void;
}

export async function prepareRunTools(state: SessionState, record: RunRecord, dependencies: ConversationDependencies,
  persistence: SessionPersistence, tools: readonly ToolSnapshot[], signal: AbortSignal, now: () => number): Promise<PreparedRunTools> {
  const authorize: RunToolPreparation['authorize'] = (snapshot, args, context) => {
    if (signal.aborted || !dependencies.store || state.active?.runId !== record.runId || record.status !== 'running'
      || state.saveState.status !== 'saved' || state.saveState.savedVersion !== state.session.version
      || context.sessionId !== record.sessionId || context.runId !== record.runId) return false;
    const call = record.toolCalls?.find(call => call.toolCallId === context.toolCallId);
    const grant = record.approvals?.find(grant => grant.approvalId === context.approval?.approvalId);
    const saved = record.toolsSnapshot?.find(tool => tool.name === snapshot.name);
    return !!call && call.status === 'running' && call.turnId === context.turnId
      && call.toolName === snapshot.name && call.toolVersion === snapshot.version && call.argsDigest === argumentsDigest(args)
      && !!saved && canonicalJson(saved) === canonicalJson(snapshot)
      && (snapshot.effect === 'read' && snapshot.approval === 'never'
        || !!grant && grant.status === 'approved' && grant.toolCallId === call.toolCallId && grant.expiresAt > Date.now()
          && grant.approvalId === call.approvalId && grant.argsDigest === call.argsDigest);
  };
  const prepared = await abortable(dependencies.prepareTools!(structuredClone(record.modelConfigSnapshot), Object.freeze({
    sessionId: record.sessionId, runId: record.runId, signal, tools, authorize })), signal);
  signal.throwIfAborted();
  const snapshots = toolSetSnapshot(prepared.tools, prepared.tools.map(tool => tool.name), record.modelConfigSnapshot,
    record.modelConfigSnapshot.thinkingLevel ?? (record.modelConfigSnapshot.reasoning ? 'high' : 'off'));
  // The selected registry is sealed before any model request.
  if (snapshots.length) Object.assign(record, { toolsSnapshot: snapshots, transcript: [], toolCalls: [], approvals: [],
    thinkingLevel: record.modelConfigSnapshot.thinkingLevel ?? (record.modelConfigSnapshot.reasoning ? 'high' : 'off') });
  touch(state, now);
  if (!await persistence.commit(state, signal)) signal.throwIfAborted();
  return { tools: snapshots, runtime: prepared.runtime };
}
