import type { AssistantMessage, Model, TranscriptContext } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { ConnectionConfiguration } from '../model-connection/configuration';
import { ModelFailure, proposalSchema } from './model';
import { requestResponse } from './responses-transport';

interface NativeItem { type: string; call_id?: string; name?: string; arguments?: string; content?: { type: string; text?: string }[] }
export async function responsesStream(configuration: Required<ConnectionConfiguration>, transport: typeof fetch, signal: AbortSignal): Promise<StreamFn> {
  const [{ createAssistantMessageEventStream }, { getCurrentSystemPrompt, getCurrentTools }] = await Promise.all([
    import('@earendil-works/pi-ai/utils/event-stream'), import('@earendil-works/pi-ai/utils/transcript'),
  ]);
  const outputs = new Map<string, NativeItem[]>(); const ids = new Set<string>(); let steps = 0; let calls = 0;
  return (model, context) => {
    const stream = createAssistantMessageEventStream(); const message = emptyMessage(model);
    void (async () => {
      signal.throwIfAborted();
      if (++steps > 12) throw new ModelFailure('本轮达到 12 次模型请求上限，请缩小任务范围后继续。');
      const input = wireInput(context, outputs, getCurrentSystemPrompt(context.messages));
      if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) throw new ModelFailure('本轮工具上下文已达到上限，请创建新会话或缩小范围。');
      const tools = getCurrentTools(context.messages).map(tool => ({ type: 'function', name: tool.name,
        description: tool.description, parameters: tool.parameters, strict: true }));
      const result = await requestResponse(configuration, transport, { input, tools, parallel_tool_calls: false, max_output_tokens: 16384,
        text: { format: { type: 'json_schema', name: 'dreamedge_changes', strict: true, schema: proposalSchema } } }, signal) as { status?: string; output?: NativeItem[] };
      if (result.status !== 'completed' || !Array.isArray(result.output)) throw new ModelFailure('模型请求未完整完成。');
      const functionCalls = result.output.filter(item => item.type === 'function_call');
      if (functionCalls.length > 8 || (calls += functionCalls.length) > 48) throw new ModelFailure('本轮达到工具调用上限，请缩小任务范围。');
      for (const item of result.output) {
        if (item.type === 'function_call') {
          if (typeof item.call_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(item.call_id) || ids.has(item.call_id)
            || typeof item.name !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(item.name) || typeof item.arguments !== 'string') throw new ModelFailure('模型工具调用格式无效。');
          let args: Record<string, unknown>;
          try { args = JSON.parse(item.arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(); }
          catch { throw new ModelFailure('模型工具参数不是有效对象。'); }
          ids.add(item.call_id); message.content.push({ type: 'toolCall', id: item.call_id, name: item.name, arguments: args as never });
        } else if (item.type === 'message') {
          for (const content of item.content ?? []) {
            if (content.type === 'refusal') throw new ModelFailure('模型拒绝了此次请求。');
            if (content.type === 'output_text' && typeof content.text === 'string') message.content.push({ type: 'text', text: content.text });
          }
        } else if (item.type !== 'reasoning') throw new ModelFailure('模型返回了未支持的工具或响应类型。');
      }
      message.responseId = String(steps); outputs.set(message.responseId, result.output);
      message.stopReason = functionCalls.length ? 'toolUse' : 'stop';
      stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message);
    })().catch(error => {
      message.content = []; message.stopReason = signal.aborted ? 'aborted' : 'error';
      message.errorMessage = error instanceof ModelFailure ? error.message : '模型响应或工具上下文无效。';
      stream.push({ type: 'error', reason: message.stopReason, error: message }); stream.end(message);
    });
    return stream;
  };
}
function wireInput(context: TranscriptContext, outputs: Map<string, NativeItem[]>, systemPrompt: string): unknown[] {
  const input: unknown[] = [{ role: 'system', content: systemPrompt }];
  for (const message of context.messages) {
    if (message.role === 'user') input.push({ role: 'user', content: message.content });
    else if (message.role === 'assistant') {
      const native = message.responseId && outputs.get(message.responseId);
      if (!native) throw new ModelFailure('Agent 响应上下文缺失。'); input.push(...native);
    } else if (message.role === 'toolResult') input.push({ type: 'function_call_output', call_id: message.toolCallId,
      output: JSON.stringify({ isError: message.isError, content: message.content }) });
  }
  return input;
}
function emptyMessage(model: Model<any>): AssistantMessage {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'pending',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
