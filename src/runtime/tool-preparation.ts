import type { ToolCallRecord, ToolSnapshot } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutor } from './tool-executor.js';
import type { ToolInspection } from '../tools/execution-policy.js';
import { inspectTool } from './tool-inspection.js';
import { NoFileEffectError } from '../files/mutation-types.js';

export interface PreparationServices {
  signal: AbortSignal; registry: ToolRegistry; executor: ToolExecutor;
  replace(call: ToolCallRecord): void; commit(): Promise<void>;
}
export interface PreparedTool { call: ToolCallRecord; snapshot: ToolSnapshot; inspection?: ToolInspection }
export async function prepareTool(s: PreparationServices, call: ToolCallRecord, snapshot: ToolSnapshot, args: unknown): Promise<PreparedTool> {
  s.executor.preflight(call, snapshot, args);
  const registered = s.registry.resolve(snapshot);
  let inspection: ToolInspection | undefined;
  const context = { sessionId: call.sessionId, runId: call.runId, turnId: call.turnId, toolCallId: call.toolCallId, signal: s.signal };
  if (registered.prepareApproval) {
    const preview = await registered.prepareApproval(call.args, context);
    s.signal.throwIfAborted(); call = { ...call, preview }; s.replace(call); await s.commit();
  }
  if (registered.inspectExecution) {
    inspection = await inspectTool(registered.inspectExecution, call.args, context, snapshot.timeoutMs);
    if (inspection.decision === 'deny') throw new NoFileEffectError(inspection.reason);
    if (snapshot.approval !== 'always' && inspection.decision === 'ask') throw new NoFileEffectError('此工具没有可用的确认流程。');
  }
  return { call, snapshot, ...(inspection ? { inspection } : {}) };
}
