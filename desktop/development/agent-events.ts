import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { DevelopmentEvent, AgentActivity } from '../../shared/contracts';
import type { ModelAccess } from './model';

const labels: Record<string, string> = { list_files: '查看目录', read_file: '读取文件', search_files: '搜索源码',
  resolve_dependency: '查询依赖', set_dependencies: '声明依赖', propose_changes: '提交修改', git_commit: '准备 Git 提交' };
export function agentEvents(access: ModelAccess, guard: (value: unknown) => void) {
  let request = 0; const details = new Map<string, string>();
  const emit = async (event: DevelopmentEvent) => { guard(event); await access.event?.(event); };
  return async (event: AgentEvent) => {
    if (event.type === 'turn_start') await emit({ id: `model-${++request}`, kind: 'model', label: '生成回复', status: 'running' });
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if ((update.type === 'thinking_end' || update.type === 'text_end') && update.content.trim()) {
        guard(event.message.content);
        const thinking = update.type === 'thinking_end';
        await emit({ id: `${thinking ? 'thinking' : 'message'}-${request}-${update.contentIndex}`, kind: thinking ? 'thinking' : 'message',
          label: thinking ? '思考摘要' : '模型说明', status: 'completed', content: update.content });
      }
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      guard(event.message.content);
      await emit({ id: `model-${request}`, kind: 'model', label: '生成回复', status: ['error', 'aborted'].includes(event.message.stopReason) ? 'failed' : 'completed' });
      for (const [index, block] of event.message.content.entries()) {
        if (block.type === 'thinking' && block.thinking.trim()) await emit({ id: `thinking-${request}-${index}`, kind: 'thinking', label: '思考摘要', status: 'completed', content: block.thinking });
        if (block.type === 'text' && block.text.trim()) await emit({ id: `message-${request}-${index}`, kind: 'message', label: '模型说明', status: 'completed', content: block.text });
      }
    }
    if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end') return;
    if (!labels[event.toolName]) return;
    if (event.type === 'tool_execution_start') {
      guard(event.args); const args = event.args as Record<string, unknown>;
      const path = typeof args.name === 'string' ? args.name : event.toolName === 'set_dependencies' ? '完整依赖声明'
        : typeof args.path === 'string' ? args.path : typeof args.directory === 'string' ? args.directory : '';
      details.set(event.toolCallId, path.slice(0, 200) || (event.toolName === 'propose_changes' ? '候选修改' : '工程目录'));
      await emit({ id: `tool-${event.toolCallId}`, kind: 'tool', tool: event.toolName, label: labels[event.toolName],
        status: 'running', detail: details.get(event.toolCallId), input: JSON.stringify(event.args, null, 2) });
    } else {
      guard(event.result);
      await emit({ id: `tool-${event.toolCallId}`, kind: 'tool', tool: event.toolName, label: labels[event.toolName],
        status: event.isError ? 'failed' : 'completed', detail: details.get(event.toolCallId),
        output: (event.result.content ?? []).filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('\n') });
    }
    if (!['list_files', 'read_file', 'search_files', 'resolve_dependency', 'set_dependencies'].includes(event.toolName)) return;
    await access.activity({ id: event.toolCallId, tool: event.toolName as AgentActivity['tool'],
      status: event.type === 'tool_execution_start' ? 'running' : event.isError ? 'failed' : 'completed', detail: details.get(event.toolCallId) ?? '工程目录' });
  };
}
