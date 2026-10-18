import { ToolNoEffectError } from '../tools/effect-error.js';
import { NoFileEffectError } from '../files/mutation-types.js';
import type { ApprovalRecord } from '../tools/types.js';
import { FileScopeError } from '../files/scope-types.js';
import type { ToolCallRecord, ToolFailure, ToolResult, ToolSnapshot } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { validateToolArguments } from '../tools/schema.js';
import { canonicalJson } from '../tools/json.js';
import { cleanToolResult } from '../tools/result.js';
export { cleanToolResult } from '../tools/result.js';
import { abortable, ModelAdapterError } from '../model/errors.js';

export interface ToolOutcome {
  status: 'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'outcome_unknown';
  result: ToolResult;
  finishedAt: number;
  startedAt?: number;
  error?: ToolFailure;
}

export function toolError(code: ToolFailure['code'], message: string,
  status: ToolOutcome['status'] = 'rejected', startedAt?: number): ToolOutcome {
  return { status, result: { content: [{ type: 'text', text: message }], details: { code } },
    finishedAt: Date.now(), ...(startedAt === undefined ? {} : { startedAt }), error: { code, message } };
}

/** Callback invocation follows the host's durable authorization and execution-intent barrier. */
export class ToolExecutor {
  readonly outcomes = new Map<string, ToolOutcome>();
  readonly invoked = new Set<string>();
  private readonly inFlight = new Map<string, Promise<ToolOutcome>>();
  private readonly identities = new Map<string, string>();

  constructor(private readonly registry: ToolRegistry, private readonly signal: AbortSignal,
    private readonly start: (call: ToolCallRecord) => Promise<ToolCallRecord>) {}

  preflight(call: ToolCallRecord, snapshot: ToolSnapshot, sdkArgs: unknown): void {
    const args = validateToolArguments(snapshot, call.args);
    if (canonicalJson(args) !== canonicalJson(sdkArgs)) throw new Error('Arguments changed');
  }

  execute(call: ToolCallRecord, snapshot: ToolSnapshot, approval?: ApprovalRecord): Promise<ToolOutcome> {
    const identity = canonicalJson({ sessionId: call.sessionId, runId: call.runId, turnId: call.turnId,
      name: call.toolName, version: call.toolVersion, digest: call.argsDigest, args: call.args });
    const previous = this.identities.get(call.toolCallId);
    if (previous && previous !== identity) throw new ModelAdapterError('UNEXPECTED_RESPONSE', '同一工具调用标识不能对应不同参数。');
    this.identities.set(call.toolCallId, identity);
    const cached = this.outcomes.get(call.toolCallId);
    if (cached) return Promise.resolve(cached);
    const pending = this.inFlight.get(call.toolCallId);
    if (pending) return pending;
    const operation = this.run(call, snapshot, approval).then(outcome => {
      this.outcomes.set(call.toolCallId, outcome); return outcome;
    });
    this.inFlight.set(call.toolCallId, operation);
    return operation;
  }

  private async run(call: ToolCallRecord, snapshot: ToolSnapshot, approval?: ApprovalRecord): Promise<ToolOutcome> {
    if (snapshot.approval === 'always' && (!['running', 'authorized'].includes(call.status) || !('approvalId' in call) || !call.approvalId)) {
      return toolError('DENIED', '工具未获授权。');
    }
    const args = validateToolArguments(snapshot, call.args);
    const registered = this.registry.resolve(snapshot);
    const running = await this.start(call);
    const startedAt = 'startedAt' in running ? running.startedAt : Date.now();
    this.signal.throwIfAborted();
    const timeout = new AbortController();
    const signal = AbortSignal.any([this.signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), snapshot.timeoutMs);
    let invoked = false;
    try {
      const operation = Promise.resolve().then(() => {
        signal.throwIfAborted();
        invoked = true;
        this.invoked.add(call.toolCallId);
        return registered.execute(structuredClone(args), { sessionId: call.sessionId, runId: call.runId,
          turnId: call.turnId, toolCallId: call.toolCallId, signal,
          ...(approval ? { approval: { approvalId: approval.approvalId, expiresAt: approval.expiresAt, ...(approval.file ? { file: approval.file } : {}) } } : {}) });
      });
      const result = registered.awaitCancellation ? await operation : await abortable(operation, signal);
      if (result.isError || result.effectState === 'unknown') {
        const unknown = snapshot.effect === 'write' && result.effectState !== 'committed';
        return { ...toolError(unknown ? 'OUTCOME_UNKNOWN' : 'TOOL_FAILED',
          unknown ? '远端工具返回错误，无法确认操作是否部分生效；不会自动重试。' : '远端工具返回错误。',
          unknown ? 'outcome_unknown' : 'failed', startedAt), result: cleanToolResult(result) };
      }
      if (result.effectState !== 'committed' || snapshot.effect !== 'write') signal.throwIfAborted();
      return { status: 'succeeded', startedAt, finishedAt: Date.now(), result: cleanToolResult(result) };
    } catch (error) {
      if (error instanceof NoFileEffectError || error instanceof ToolNoEffectError) return this.signal.aborted
        ? toolError('CANCELLED', error.message, 'cancelled', startedAt) : toolError(error.code, error.message, 'failed', startedAt);
      if (snapshot.effect === 'write' && invoked) return toolError('OUTCOME_UNKNOWN',
        '写操作已经启动，无法确认是否生效；不会自动重新执行。', 'outcome_unknown', startedAt);
      if (this.signal.aborted) return toolError('CANCELLED', '工具调用已取消。', 'cancelled', startedAt);
      if (timeout.signal.aborted) return toolError('TIMEOUT', '工具执行超时。', 'failed', startedAt);
      if (error instanceof FileScopeError) return toolError(error.code.startsWith('FILE_SCOPE_') ? 'DENIED' : 'TOOL_FAILED', error.message, 'failed', startedAt);
      return toolError('TOOL_FAILED', '工具执行失败。', 'failed', startedAt);
    } finally { clearTimeout(timer); }
  }
}
