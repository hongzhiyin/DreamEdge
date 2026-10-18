import type { ToolCallRecord, ToolSnapshot } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutor } from './tool-executor.js';
import type { ToolApprovals } from './tool-approvals.js';
import { toolError } from './tool-executor.js';
import { NoFileEffectError } from '../files/mutation-types.js';
import { FileScopeError } from '../files/scope-types.js';
import type { ToolInspection } from '../tools/execution-policy.js';
import { prepareTool } from './tool-preparation.js';

interface BeforeServices {
  call: ToolCallRecord; snapshot: ToolSnapshot | undefined; signal: AbortSignal; registry: ToolRegistry;
  executor: ToolExecutor; approvals: ToolApprovals; replace(call: ToolCallRecord): void; commit(): Promise<void>;
}
export async function beforeToolCall(s: BeforeServices, sdkArgs: unknown) {
  let call = s.call; const snapshot = s.snapshot;
  if (call.status === 'rejected' || s.signal.aborted) return { block: true, terminate: true, reason: '工具调用未获执行许可。' };
  try { if (!snapshot) throw 0; s.executor.preflight(call, snapshot, sdkArgs); }
  catch { s.executor.outcomes.set(call.toolCallId, toolError('INVALID_ARGUMENTS', '工具参数无效。')); return { block: true, reason: '工具参数无效。' }; }
  let inspection: ToolInspection | undefined;
  try {
    const prepared = await prepareTool(s, call, snapshot!, sdkArgs);
    call = prepared.call; inspection = prepared.inspection;
  } catch (error) {
    const message = error instanceof NoFileEffectError || error instanceof FileScopeError ? error.message : '执行前检查未完成，工具未执行。';
    s.executor.outcomes.set(call.toolCallId, toolError('DENIED', message));
    return { block: true, terminate: s.signal.aborted, reason: message };
  }
  if (snapshot!.approval === 'always' && !await s.approvals.permit(call, snapshot!, inspection)) {
    return { block: true, terminate: s.signal.aborted, reason: '工具调用未获授权。' };
  }
  return undefined;
}
