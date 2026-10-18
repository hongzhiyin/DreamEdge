import type { ToolRunData } from '../runtime/tool-contracts.js';
import type { RunRecord } from './types.js';
import type { SessionState } from './state.js';
import type { SessionPersistence } from './persistence.js';
import { touch } from './state.js';
import { canonicalJson } from '../tools/json.js';
import { validateStored } from '../storage/validation.js';

export function toolCheckpoint(state: SessionState, record: RunRecord, persistence: SessionPersistence, now: () => number) {
  return async (data: ToolRunData, signal: AbortSignal): Promise<boolean> => {
    if (state.active?.runId !== record.runId) return false;
    if (canonicalJson(data.toolsSnapshot) !== canonicalJson(record.toolsSnapshot ?? [])) throw new Error('Tool snapshot changed');
    const copy = structuredClone(data);
    const candidate = { ...record, ...copy };
    validateStored({ session: state.session, messages: state.messages,
      runs: state.runs.map(run => run.runId === record.runId ? candidate : run) });
    Object.assign(record, copy); touch(state, now);
    return persistence.commit(state, signal);
  };
}
