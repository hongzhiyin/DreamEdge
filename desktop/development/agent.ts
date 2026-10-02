import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import type { AgentActivity } from '../../shared/contracts';
import type { ConnectionConfiguration } from '../model-connection/vault';
import { ModelFailure, modelInstructions, type ModelAccess, type ModelInput } from './model';
import { projectTools } from './agent-tools';
import { responsesStream } from './agent-transport';

export async function runProjectAgent(input: ModelInput, configuration: Required<ConnectionConfiguration>, transport: typeof fetch, signal: AbortSignal, access: ModelAccess): Promise<unknown> {
  const { runAgentLoop } = await import('@earendil-works/pi-agent-core');
  const model: Model<'openai-responses'> = { id: configuration.model, name: configuration.model, provider: 'dreamedge', api: 'openai-responses',
    baseUrl: configuration.baseUrl, input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const guard = (value: unknown) => { if (JSON.stringify(value).includes(configuration.apiKey)) throw new ModelFailure('读取内容包含模型连接凭据，已拒绝发送。'); };
  let final: AssistantMessage | undefined;
  const details = new Map<string, string>();
  const messages = await runAgentLoop([{ role: 'user', content: JSON.stringify({ request: input.prompt, project: input.context, history: input.history }), timestamp: Date.now() }],
    { messages: [{ role: 'system', content: modelInstructions, timestamp: Date.now() }],
      tools: projectTools(access, signal, guard) },
    { model, convertToLlm: messages => messages as Message[], toolExecution: 'sequential' }, async event => {
      signal.throwIfAborted();
      if (event.type === 'message_end' && event.message.role === 'assistant') final = event.message;
      if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end') return;
      if (!['list_files', 'read_file', 'search_files'].includes(event.toolName)) return;
      if (event.type === 'tool_execution_start') {
        const args = event.args as Record<string, unknown>;
        const path = typeof args.path === 'string' ? args.path : typeof args.directory === 'string' ? args.directory : '';
        details.set(event.toolCallId, path.slice(0, 200) || '源码目录');
      }
      await access.activity({ id: event.toolCallId, tool: event.toolName as AgentActivity['tool'],
        status: event.type === 'tool_execution_start' ? 'running' : event.isError ? 'failed' : 'completed', detail: details.get(event.toolCallId) ?? '源码目录' });
    }, signal, await responsesStream(configuration, transport, signal));
  signal.throwIfAborted();
  final = messages.filter((message): message is AssistantMessage => message.role === 'assistant').at(-1) ?? final;
  if (!final || final.stopReason !== 'stop') throw new ModelFailure(final?.errorMessage ?? 'Agent 未返回完整候选修改。');
  const text = final.content.filter(content => content.type === 'text').map(content => content.text).join('');
  try { return JSON.parse(text); } catch { throw new ModelFailure('模型返回的候选变更不是有效 JSON。'); }
}
