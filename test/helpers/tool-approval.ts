import type { TestContext } from 'node:test';
import { Type } from 'typebox';
import { ToolRegistry } from '../../src/index.js';
import type { ApprovalDecisionCommand, ToolRuntimeOptions } from '../../src/index.js';
import { toolLoopFixture, toolReply } from './tool-loop.js';
import { chatReply } from './server.js';
import type { Handler } from './server.js';
import { waitUntil } from './storage.js';

export async function approvalFixture(t: TestContext, execute: (signal: AbortSignal) => Promise<string>,
  options: ToolRuntimeOptions = {}, timeoutMs = 1000, effect: 'read' | 'write' = 'write', continuation?: Handler) {
  const registry = new ToolRegistry();
  registry.register({ name: 'fixture', version: '1', label: '测试操作', description: 'Isolated test operation',
    parameters: Type.Object({}, { additionalProperties: false }), effect, approval: 'always',
    resources: ['temporary-fixture'], timeoutMs,
    async execute(_args, context) { return { content: [{ type: 'text', text: await execute(context.signal) }] }; } });
  const fixture = await toolLoopFixture(t, (response, request) => {
    if ((request.body.messages as { role: string }[]).at(-1)?.role === 'tool') {
      if (continuation) continuation(response, request); else chatReply(response);
    }
    else toolReply(response, [{ id: `call-${Date.now()}`, name: 'fixture', args: {} }]);
  }, registry, options);
  return { ...fixture, approval: async (decision: 'approve' | 'reject' = 'approve'): Promise<ApprovalDecisionCommand> => {
    await waitUntil(() => fixture.service.getSnapshot(fixture.sessionId).runs.at(-1)?.toolCalls?.at(-1)?.status === 'awaiting_approval');
    const receipt = fixture.service.getSnapshot(fixture.sessionId).runs.at(-1)!.approvals!.at(-1)!;
    return { sessionId: receipt.sessionId, runId: receipt.runId, turnId: receipt.turnId, toolCallId: receipt.toolCallId,
      toolName: receipt.toolName, toolVersion: receipt.toolVersion, argsDigest: receipt.argsDigest,
      approvalId: receipt.approvalId, decision };
  } };
}
