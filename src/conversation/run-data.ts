import type { ToolRunRecord } from '../runtime/tool-contracts.js';
import type { ToolRunData } from '../runtime/tool-contracts.js';
import type { RunRecord } from './types.js';

export function hasRunData<T extends Partial<ToolRunData>>(run: T): run is T & ToolRunData {
  return Array.isArray(run.toolsSnapshot) && Array.isArray(run.transcript)
    && Array.isArray(run.toolCalls) && Array.isArray(run.approvals);
}

/** Adapts v1 completed text runs without changing their original native reply or identities. */
export function normalizeRun(run: RunRecord): RunRecord {
  if (hasRunData(run) || run.status !== 'completed' || !run.nativeMessage) return structuredClone(run);
  return { ...structuredClone(run), toolsSnapshot: [], toolCalls: [], approvals: [], transcript: [{
    sessionId: run.sessionId, runId: run.runId, turnId: `${run.runId}:text-turn`,
    messageId: `${run.runId}:text-message`, ordinal: 0, message: structuredClone(run.nativeMessage),
  }] };
}
