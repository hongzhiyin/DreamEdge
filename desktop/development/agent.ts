import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import type { AgentActivity } from '../../shared/contracts';
import type { ConnectionConfiguration } from '../model-connection/configuration';
import { ModelFailure, modelInstructions, type ModelAccess, type ModelInput } from './model';
import { projectTools } from './agent-tools';
import { responsesStream } from './agent-transport';

export async function runProjectAgent(input: ModelInput, configuration: Required<ConnectionConfiguration>, transport: typeof fetch, signal: AbortSignal, access: ModelAccess): Promise<unknown> {
  const { runAgentLoop } = await import('@earendil-works/pi-agent-core');
  const model: Model<'openai-responses'> = { id: configuration.model, name: configuration.model, provider: 'dreamedge', api: 'openai-responses',
    baseUrl: configuration.baseUrl, input: ['text'], reasoning: false, contextWindow: 128000, maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const guard = (value: unknown) => { if (JSON.stringify(value).includes(configuration.apiKey)) throw new ModelFailure('读取内容包含模型连接凭据，已拒绝发送。'); };
  let final: AssistantMessage | undefined; let proposal: Record<string, unknown> | undefined; let reminders = 0;
  const details = new Map<string, string>();
  const messages = await runAgentLoop([{ role: 'user', content: JSON.stringify({ request: input.prompt, project: input.context, history: input.history }), timestamp: Date.now() }],
    { messages: [{ role: 'system', content: modelInstructions, timestamp: Date.now() }],
      tools: projectTools(access, signal, guard, value => { proposal = value; }) },
    { model, convertToLlm: messages => messages as Message[], toolExecution: 'sequential',
      finishTurn: ({ message, toolResults }) => {
        if (proposal) return { action: 'end' };
        if (message.stopReason === 'stop' && !toolResults.length) {
          if (++reminders > 2) throw new ModelFailure('模型未通过候选工具提交有效修改；源码未被修改，请重试。');
          return { action: 'continue' };
        }
      },
      prepareNextTurn: ({ message, toolResults }) => !proposal && message.stopReason === 'stop' && !toolResults.length
        ? { messages: [{ role: 'user', content: 'Finish by calling propose_changes with summary and files. Your preceding text was not submitted as a candidate. Source is unchanged. Use files: [] if no edits are needed.', timestamp: Date.now() }] } : undefined,
    }, async event => {
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
  if (proposal) return proposal;
  throw new ModelFailure(final?.errorMessage ?? 'Agent 未提交有效候选修改；源码未被修改。');
}
