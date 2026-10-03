import type { AssistantMessage } from '@earendil-works/pi-ai';
import { agentEvents } from './agent-events';
import type { ConnectionConfiguration } from '../model-connection/configuration';
import { ModelFailure, modelInstructions, type ModelAccess, type ModelInput } from './model';
import { projectTools } from './agent-tools';
import { piProvider } from './pi-provider';

export async function runProjectAgent(input: ModelInput, configuration: Required<ConnectionConfiguration>, transport: typeof fetch, signal: AbortSignal, access: ModelAccess): Promise<unknown> {
  const { Agent } = await import('@earendil-works/pi-agent-core');
  const { model, stream } = await piProvider(configuration, transport, signal);
  const guard = (value: unknown) => { if (JSON.stringify(value).includes(configuration.apiKey)) throw new ModelFailure('读取内容包含模型连接凭据，已拒绝发送。'); };
  let final: AssistantMessage | undefined; let proposal: Record<string, unknown> | undefined; let reminders = 0;
  const progress = agentEvents(access, guard);
  const messages = input.history.flatMap(turn => [
    { role: 'user' as const, content: turn.prompt, timestamp: Date.now() },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: JSON.stringify({ summary: turn.summary,
      dependencies: turn.dependencies, files: turn.changes.map(({ path, content }) => ({ path, content })) }) }], timestamp: Date.now(), api: model.api,
      provider: model.provider, model: model.id, stopReason: 'stop' as const,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  ]);
  const agent = new Agent({
    initialState: { model, systemPrompt: modelInstructions + (input.commit ? ' The current user requested a Git commit; queue git_commit.' : '')
      + (input.restore ? ' The current user requested restore; inspect history and queue git_restore, then finish with empty files.' : ''),
      messages, tools: projectTools(access, signal, guard, value => { proposal = value; }, input.commit, input.restore) },
    streamFn: stream, toolExecution: 'sequential',
    finishTurn: ({ message, toolResults }) => {
        if (proposal) return { action: 'end' };
        if (message.stopReason === 'stop' && !toolResults.length) {
          if (++reminders > 2) throw new ModelFailure('模型未通过候选工具提交有效修改；源码未被修改，请重试。');
          return { action: 'continue' };
        }
      },
      prepareNextTurnWithContext: ({ message, toolResults }) => !proposal && message.stopReason === 'stop' && !toolResults.length
        ? { messages: [{ role: 'user', content: 'Finish by calling propose_changes with summary and files. Your preceding text was not submitted as a candidate. Source is unchanged. Use files: [] if no edits are needed.', timestamp: Date.now() }] } : undefined,
    });
  let calls = 0;
  const stop = agent.subscribe(async event => {
      signal.throwIfAborted();
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        guard(event.message.content);
        if (event.message.stopReason === 'length') throw new ModelFailure('模型输出达到长度上限，请缩小修改范围后重新请求。');
        if (Buffer.byteLength(JSON.stringify(event.message)) > 1024 * 1024) throw new ModelFailure('模型输出超过大小限制。');
        final = event.message;
      }
      if (event.type === 'tool_execution_start' && ++calls > 48) throw new ModelFailure('本轮达到工具调用上限，请缩小任务范围。');
      await progress(event);
    });
  const cancel = () => agent.abort(); signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    await agent.prompt(JSON.stringify({ request: input.prompt, project: input.context }));
  } finally { signal.removeEventListener('abort', cancel); stop(); }
  signal.throwIfAborted();
  if (final?.stopReason === 'error' || final?.stopReason === 'aborted') throw new ModelFailure(final.errorMessage ?? 'Agent 请求已停止。');
  if (proposal) return proposal;
  throw new ModelFailure(final?.errorMessage ?? 'Agent 未提交有效候选修改；源码未被修改。');
}
