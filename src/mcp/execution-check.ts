import type { JsonObject } from '@earendil-works/pi-ai';
import type { ToolExecutionContext, ToolSnapshot } from '../tools/types.js';
import type { McpRunScope } from './tool-binding.js';
import { ToolNoEffectError } from '../tools/effect-error.js';

export function mcpExecutionCheck(scope: McpRunScope, snapshot: ToolSnapshot, args: JsonObject,
  context: ToolExecutionContext, current: () => void, used: Set<string>): () => void {
  const check = () => {
    scope.signal.throwIfAborted(); context.signal.throwIfAborted(); current();
    if (context.sessionId !== scope.sessionId || context.runId !== scope.runId
      || (snapshot.approval !== 'never' && (!context.approval || context.approval.expiresAt <= Date.now()))
      || !scope.authorize(snapshot, args, context)) throw new Error('Denied');
  };
  try { check(); if (used.has(context.toolCallId)) throw new Error('Duplicate'); }
  catch { throw new ToolNoEffectError('DENIED', 'MCP 运行快照或执行批准已失效，请求未发送。'); }
  used.add(context.toolCallId); return check;
}
