import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { connectModel } from '../model/connection.js';
import { prepareContext } from '../model/context.js';
import { parseModelConnection } from '../model/config.js';
import { ModelAdapterError } from '../model/errors.js';
import { failure } from '../model/errors.js';
import type { ToolRuntimeOptions } from './tool-contracts.js';
import { ToolFlow } from './tool-flow.js';
import type {
  AgentRuntime, CredentialResolver, ModelConnectionConfig, RuntimeEvent,
  RuntimeHandle, RuntimeObserver, RuntimeRequest, RuntimeResult, ThinkingLevel,
} from '../model/types.js';
import { settleResult } from './outcome.js';

type EventPayload = RuntimeEvent extends infer T
  ? T extends RuntimeEvent ? Omit<T, 'sessionId' | 'runId' | 'sequence'> : never : never;

export class PiRuntime implements AgentRuntime {
  private readonly connection: ModelConnectionConfig;
  private readonly options: ToolRuntimeOptions;

  constructor(connection: ModelConnectionConfig, private readonly credentials: CredentialResolver,
    options: ToolRuntimeOptions = {}) {
    this.connection = parseModelConnection(connection);
    this.options = Object.freeze({ ...options });
  }

  start(request: RuntimeRequest, observer?: RuntimeObserver): RuntimeHandle {
    const controller = new AbortController();
    let finished = false;
    let flow: ToolFlow | undefined;
    const cancel = () => {
      if (!finished && !controller.signal.aborted) {
        controller.abort(new DOMException('用户停止生成。', 'AbortError'));
      }
    };
    const { checkpoint, beforeModelRequest, ...input } = request;
    let snapshot: RuntimeRequest;
    try { snapshot = { ...structuredClone(input), ...(checkpoint ? { checkpoint } : {}), ...(beforeModelRequest ? { beforeModelRequest } : {}) }; }
    catch { snapshot = { sessionId: request.sessionId, runId: request.runId, messages: [] }; }
    const done = this.execute(snapshot, controller, observer, () => { finished = true; }, value => { flow = value; });
    return { cancel, done, decideApproval: command => !finished && (flow?.approvals.decide(command) ?? false) };
  }

  private async execute(
    request: RuntimeRequest, controller: AbortController,
    observer: RuntimeObserver | undefined, finish: () => void, register: (flow: ToolFlow) => void,
  ): Promise<RuntimeResult> {
    let agent: Agent | undefined;
    let tools: ToolFlow | undefined;
    let message: AssistantMessage | undefined;
    let secret: string | undefined;
    let effectiveThinking: ThinkingLevel | undefined;
    let caught: unknown;
    let deliveryFailed = false;
    let sequence = 0;
    let unsubscribe: (() => void) | undefined;
    const { signal } = controller;
    const timeout = setTimeout(() => {
      controller.abort(new ModelAdapterError('REQUEST_TIMEOUT', '模型请求超时。'));
    }, this.connection.timeoutMs ?? 120_000);
    const abortAgent = () => agent?.abort();
    signal.addEventListener('abort', abortAgent);
    const publish = async (payload: EventPayload) => {
      if (deliveryFailed) return;
      const event = { sessionId: request.sessionId, runId: request.runId, sequence: ++sequence, ...payload };
      try { await observer?.(event, signal); }
      catch {
        if (signal.aborted) throw signal.reason;
        deliveryFailed = true;
        const error = new ModelAdapterError('EVENT_DELIVERY_FAILED', '运行事件处理失败。');
        controller.abort(error);
        throw error;
      }
    };
    try {
      if (request.tools !== undefined && !Array.isArray(request.tools)) {
        throw new ModelAdapterError('TOOLS_NOT_ENABLED', '工具快照无效。');
      }
      if (request.tools?.length) { tools = new ToolFlow(request, controller, this.options, this.connection); register(tools); }
      const context = prepareContext(request);
      await tools?.initialize();
      const connection = await connectModel(this.connection, this.credentials, signal, request.thinkingLevel);
      secret = connection.secret;
      effectiveThinking = connection.thinkingLevel;
      signal.throwIfAborted();
      agent = new Agent({
        initialState: { model: connection.model, messages: tools?.messages() ?? context, tools: tools?.bindings() ?? [], thinkingLevel: effectiveThinking },
        toolExecution: 'sequential',
        streamFn: (model, input, options) => connection.models.streamSimple(model, input, {
          ...options, maxTokens: connection.config.maxOutputTokens,
          timeoutMs: connection.config.timeoutMs ?? 120_000, maxRetries: 0,
          cacheRetention: 'none', toolChoice: tools ? 'auto' : 'none',
        }),
        beforeToolCall: async ({ toolCall, args }) => tools
          ? tools.before(toolCall.id, args) : { block: true, terminate: true, reason: '文字对话不执行工具。' },
        prepareRequest: async ({ context }) => {
          const messages = tools?.messages() ?? context.messages as Message[];
          try { await request.beforeModelRequest?.(messages, signal); }
          catch (error) { if (error instanceof ModelAdapterError) controller.abort(error); throw error; }
          signal.throwIfAborted();
          return tools ? { context: { ...context, messages } } : undefined;
        },
        finishTurn: async ({ message }) => tools ? tools.finishTurn(message) : { action: 'end' },
      });
      unsubscribe = agent.subscribe(async (event: AgentEvent) => {
        if (tools && event.type === 'turn_start') message = undefined;
        if ((event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant') {
          const incoming = event.message;
          const emptyFailure = ['error', 'aborted'].includes(incoming.stopReason)
            && incoming.content.every(block => block.type === 'text' && !block.text);
          message = emptyFailure && message ? {
            ...message, stopReason: incoming.stopReason,
            ...(incoming.errorMessage ? { errorMessage: incoming.errorMessage } : {}),
          } : incoming;
          if (message.errorMessage) message = { ...message, errorMessage: failure(new Error(message.errorMessage), secret).message };
          if (!tools && event.message.content.some(block => block.type === 'toolCall')) {
            controller.abort(new ModelAdapterError('UNEXPECTED_RESPONSE', '文字对话收到未启用的工具调用。'));
            return;
          }
        }
        if (tools) {
          const owned = event.type === 'message_end' && event.message.role === 'assistant' && event.message.errorMessage
            ? { ...event, message: { ...event.message, errorMessage: failure(new Error(event.message.errorMessage), secret).message } }
            : event;
          try { await tools.event(owned); }
          catch (error) {
            if (error instanceof ModelAdapterError) controller.abort(error);
            throw error;
          }
          if (event.type === 'message_start' && event.message.role === 'assistant' && !signal.aborted) {
            await publish({ type: 'message_started', turnId: tools.turnId, messageId: tools.messageId, role: 'assistant' });
          }
        }
        if (signal.aborted || event.type !== 'message_update') return;
        const delta = event.assistantMessageEvent;
        if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
          await publish({ type: 'delta', channel: delta.type === 'text_delta' ? 'text' : 'thinking', delta: delta.delta });
        }
      });
      await publish({ type: 'started', connectionId: connection.config.id, model: connection.model.id,
        thinkingLevel: effectiveThinking, notices: connection.notices });
      signal.throwIfAborted();
      await agent.continue();
      await agent.waitForIdle();
    } catch (error) { caught = error; }
    finally {
      await tools?.close();
      clearTimeout(timeout);
      signal.removeEventListener('abort', abortAgent);
      unsubscribe?.();
      finish();
    }
    let result = settleResult(request, message, signal, caught, secret, effectiveThinking);
    if (tools) result.toolData = tools.snapshot();
    try { await publish({ type: 'settled', result: structuredClone(result) }); }
    catch (error) {
      result = settleResult(request, message, signal, error, secret, effectiveThinking);
      if (tools) result.toolData = tools.snapshot();
    }
    return result;
  }
}
