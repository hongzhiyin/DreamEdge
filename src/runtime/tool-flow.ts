import { FileBatches } from './file-batches.js';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai';
import { getCurrentTools, getToolStateChanges } from '@earendil-works/pi-ai';
import type { RuntimeRequest } from '../model/types.js';
import type { ToolRunData, ToolRuntimeOptions } from './tool-contracts.js';
import type { ToolCallRecord } from '../tools/types.js';
import { toolSetSnapshot } from '../tools/snapshot.js';
import { argumentsDigest } from '../tools/json.js';
import { ModelAdapterError } from '../model/errors.js';
import { validateModelMessage } from '../model/message-validation.js';
import { ToolExecutor, toolError } from './tool-executor.js';
import { beforeToolCall } from './tool-before.js';
import { interruptToolData } from './tool-settlement.js';
import { ToolApprovals } from './tool-approvals.js';

export class ToolFlow {
  readonly data: ToolRunData;
  readonly executor: ToolExecutor;
  readonly approvals: ToolApprovals;
  private readonly batches: FileBatches;
  turnId = randomUUID();
  messageId = randomUUID();
  turns = 0;
  private readonly maxTurns: number;
  private readonly maxCalls: number;

  constructor(private readonly request: RuntimeRequest, private readonly controller: AbortController,
    private readonly options: ToolRuntimeOptions, connection: import('../model/types.js').ModelConnectionConfig) {
    this.maxTurns = options.maxModelTurns ?? 16; this.maxCalls = options.maxToolCalls ?? 64;
    const approvalTtl = options.approvalTtlMs ?? 120_000;
    for (const limit of [this.maxTurns, this.maxCalls, approvalTtl]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new ModelAdapterError('INVALID_CONFIG', '工具运行限制无效。');
    }
    if (approvalTtl > 2_147_483_647) throw new ModelAdapterError('INVALID_CONFIG', '授权有效期无效。');
    if (!options.registry || typeof request.checkpoint !== 'function') throw new ModelAdapterError('TOOLS_NOT_ENABLED', '工具执行需要注册表和持久化接口。');
    const snapshots = toolSetSnapshot(request.tools ?? [], (request.tools ?? []).map(tool => tool.name), connection,
      request.thinkingLevel ?? connection.thinkingLevel ?? (connection.reasoning ? 'high' : 'off'));
    for (const snapshot of snapshots) {
      options.registry.resolve(snapshot);
      if (snapshot.approval === 'always' && request.approvalsEnabled !== true) {
        throw new ModelAdapterError('TOOLS_NOT_ENABLED', '需要确认的工具必须接入持久化授权接口。');
      }
    }
    this.data = { toolsSnapshot: snapshots, transcript: [], toolCalls: [], approvals: [] };
    this.approvals = new ToolApprovals(this.data, controller.signal, () => this.commit(), approvalTtl);
    this.executor = new ToolExecutor(options.registry, controller.signal, async call => {
      if (!this.approvals.authorized(call)) throw new ModelAdapterError('TOOLS_NOT_ENABLED', '工具未获授权。');
      if (call.status === 'running') return call;
      const running: ToolCallRecord = { ...call, status: 'running', startedAt: Date.now() };
      this.replace(running); await this.commit(); return running;
    });
    this.batches = new FileBatches(this.data, { signal: controller.signal, registry: options.registry,
      executor: this.executor, replace: call => this.replace(call), commit: () => this.commit() }, this.approvals, request.batchRecovery);

  }

  bindings(): AgentTool[] {
    return this.data.toolsSnapshot.map(snapshot => ({ name: snapshot.name, label: snapshot.label,
      description: snapshot.description, parameters: snapshot.parameters, executionMode: 'sequential',
      execute: async id => {
        const call = this.call(id);
        const outcome = await this.executor.execute(call, snapshot, this.approvals.receipt(call));
        return { content: [...outcome.result.content], details: outcome.result.details ?? {}, isError: outcome.status !== 'succeeded' };
      } }));
  }

  async initialize(): Promise<void> {
    const changes = getToolStateChanges(getCurrentTools([...this.request.messages]), this.data.toolsSnapshot.map(tool => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
    })));
    if (!changes.toolsAdded.length && !changes.toolsRemoved.length) return;
    this.append({ role: 'system', content: '', timestamp: Date.now(),
      ...(changes.toolsAdded.length ? { toolsAdded: changes.toolsAdded } : {}),
      ...(changes.toolsRemoved.length ? { toolsRemoved: changes.toolsRemoved } : {}) });
    await this.commit();
  }

  async before(id: string, sdkArgs: unknown) {
    const batch = await this.batches.before(this.call(id), sdkArgs);
    if (batch.handled) return batch.allowed ? undefined : { block: true, terminate: this.controller.signal.aborted, reason: '批量计划未获执行许可。' };
    return beforeToolCall({ call: this.call(id), snapshot: this.data.toolsSnapshot.find(t => t.name === this.call(id).toolName),
      signal: this.controller.signal, registry: this.options.registry!, executor: this.executor, approvals: this.approvals,
      replace: call => this.replace(call), commit: () => this.commit() }, sdkArgs);
  }

  async event(event: AgentEvent): Promise<void> {
    if (event.type === 'turn_start') { this.turnId = randomUUID(); this.turns++; }
    if (event.type === 'message_start' && event.message.role !== 'user') {
      if (event.message.role === 'assistant' && this.data.transcript.some(entry => entry.turnId === this.turnId
        && entry.message.role === 'assistant')) this.turnId = randomUUID();
      this.messageId = randomUUID();
    }
    if (event.type !== 'message_end' || event.message.role === 'user') return;
    const message = JSON.parse(JSON.stringify(event.message)) as typeof event.message;
    if (message.role === 'assistant') {
      if (this.controller.signal.aborted && ['aborted', 'error'].includes(message.stopReason)) {
        interruptToolData(this.data, this.request, this.executor.outcomes, this.executor.invoked);
      }
      const calls = message.content.filter(block => block.type === 'toolCall');
      if (calls.length && message.stopReason !== 'toolUse') {
        message.content = message.content.filter(block => block.type !== 'toolCall');
        if (message.stopReason === 'length') this.controller.abort(new ModelAdapterError('OUTPUT_LIMIT', '工具调用参数未完整输出。'));
      } else {
        validateModelMessage(message);
        const ids = new Set(this.data.toolCalls.map(call => call.toolCallId));
        const overLimit = this.data.toolCalls.length + calls.length > this.maxCalls;
        const records: ToolCallRecord[] = calls.map(call => {
          if (ids.has(call.id)) throw new ModelAdapterError('UNEXPECTED_RESPONSE', '工具调用标识重复。');
          ids.add(call.id);
          const tool = this.data.toolsSnapshot.find(tool => tool.name === call.name);
          const base = { sessionId: this.request.sessionId, runId: this.request.runId, turnId: this.turnId,
            toolCallId: call.id, toolName: call.name, toolVersion: tool?.version ?? 'unregistered',
            args: call.arguments, argsDigest: argumentsDigest(call.arguments), effect: tool?.effect ?? 'read',
            approval: tool?.approval ?? 'never', createdAt: Date.now() };
          if (!tool || overLimit) return { ...base, status: 'rejected', finishedAt: Date.now(), error: {
            code: overLimit ? 'DENIED' : 'UNKNOWN_TOOL', message: overLimit ? '工具调用次数达到上限。' : '工具未注册。' } };
          return { ...base, status: 'requested' };
        });
        this.data.toolCalls = [...this.data.toolCalls, ...records];
        this.append(message); await this.commit();
        if (overLimit) this.controller.abort(new ModelAdapterError('RUN_LIMIT', '工具调用次数达到上限。'));
        return;
      }
    } else if (message.role === 'toolResult') {
      const call = this.data.toolCalls.find(call => call.toolCallId === message.toolCallId);
      if (!call) return;
      if (this.data.transcript.some(entry => entry.message.role === 'toolResult' && entry.message.toolCallId === call.toolCallId)) return;
      const outcome = this.executor.outcomes.get(call.toolCallId) ?? ('error' in call
        ? toolError(call.error.code, call.error.message)
        : this.controller.signal.aborted ? toolError('CANCELLED', '工具调用已取消。', 'cancelled')
          : toolError('INVALID_ARGUMENTS', '工具参数无效。'));
      const result: ToolResultMessage = { ...message, content: [...outcome.result.content],
        details: outcome.result.details ?? {}, isError: outcome.status !== 'succeeded' };
      if (call.status === 'rejected' || call.status === 'cancelled') { /* Keep sealed decisions immutable. */ }
      else if (outcome.status === 'succeeded') this.replace({ ...call, status: 'succeeded', startedAt: outcome.startedAt!,
        finishedAt: outcome.finishedAt, result: outcome.result });
      else this.replace({ ...call, status: outcome.status, finishedAt: outcome.finishedAt,
        ...(outcome.startedAt === undefined ? {} : { startedAt: outcome.startedAt }), error: outcome.error! } as ToolCallRecord);
      this.append(result);
      if (outcome.status === 'outcome_unknown' && !this.controller.signal.aborted) {
        await this.commit(); this.controller.abort(new ModelAdapterError('OUTCOME_UNKNOWN', '写操作结果无法确认，核对实际结果后再发起新操作。'));
      } else await this.commit();
      if (outcome.status !== 'succeeded' && this.approvals.receipt(call)?.batch && !this.controller.signal.aborted) {
        this.controller.abort(new ModelAdapterError('REQUEST_FAILED', '批次已停止；已完成项保留，剩余项未继续执行。'));
      }
      return;
    }
    if (message.role !== 'assistant' && message.role !== 'system') {
      throw new ModelAdapterError('UNEXPECTED_RESPONSE', '运行时收到不支持的扩展消息。');
    }
    this.append(message); await this.commit();
  }

  finishTurn(message: AssistantMessage) {
    if (message.content.some(block => block.type === 'toolCall') && this.turns >= this.maxTurns) {
      this.controller.abort(new ModelAdapterError('RUN_LIMIT', '模型运行轮次达到上限。'));
    }
    return this.controller.signal.aborted || message.stopReason !== 'toolUse' ? { action: 'end' as const } : undefined;
  }

  messages(): Message[] { return structuredClone([...this.request.messages, ...this.data.transcript.map(entry => entry.message)]); }
  snapshot(): ToolRunData { return structuredClone(this.data); }
  call(id: string): ToolCallRecord {
    const call = this.data.toolCalls.find(call => call.toolCallId === id);
    if (!call) throw new ModelAdapterError('UNEXPECTED_RESPONSE', '工具调用记录缺失。');
    return call;
  }

  async close(): Promise<void> {
    const changed = interruptToolData(this.data, this.request, this.executor.outcomes, this.executor.invoked);
    for (const call of this.data.toolCalls) {
      const snapshot = this.data.toolsSnapshot.find(t => t.name === call.toolName);
      if (snapshot) await this.options.registry?.resolve(snapshot).release?.({ sessionId: call.sessionId, runId: call.runId, turnId: call.turnId, toolCallId: call.toolCallId, signal: this.controller.signal });
    }
    if (!changed) return;
    try { await this.request.checkpoint!(this.snapshot(), this.controller.signal); } catch { /* Retain final data for save retry. */ }
  }

  private append(message: Exclude<Message, { role: 'user' }>): void {
    validateModelMessage(message);
    this.data.transcript = [...this.data.transcript, { sessionId: this.request.sessionId, runId: this.request.runId,
      turnId: this.turnId, messageId: this.messageId, ordinal: this.data.transcript.length, message }];
  }
  private replace(call: ToolCallRecord): void { this.data.toolCalls = this.data.toolCalls.map(old => old.toolCallId === call.toolCallId ? call : old); }
  private async commit(): Promise<void> {
    try {
      if (await this.request.checkpoint!(this.snapshot(), this.controller.signal)) return;
    } catch { /* Provider/tool errors must not reveal storage details. */ }
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    const error = new ModelAdapterError('EVENT_DELIVERY_FAILED', '工具运行记录无法提交。');
    this.controller.abort(error); throw error;
  }
}
