import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { ToolRegistry } from '../src/index.js';
import type { ToolInspection } from '../src/tools/execution-policy.js';
import { toolLoopFixture, toolReply } from './helpers/tool-loop.js';
import { beginSse, chatChunk, deadline } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';

for (const mode of ['throw', 'invalid', 'timeout', 'cancel', 'deny', 'allow'] as const) {
  test(`pre-execution inspection ${mode} is enforced by Pi and preserves durable authorization`, async t => {
    const registry = new ToolRegistry(); let executions = 0; let entered = false;
    registry.register({ name: 'check_write', version: '1', label: 'checked write', description: 'isolated counter',
      parameters: Type.Object({}, { additionalProperties: false }), effect: 'write', approval: 'always', resources: ['counter'], timeoutMs: mode === 'timeout' ? 40 : 1000,
      async inspectExecution() {
        entered = true;
        if (mode === 'throw') throw new Error('private policy error');
        if (mode === 'invalid') return undefined as unknown as ToolInspection;
        if (mode === 'timeout' || mode === 'cancel') return new Promise<ToolInspection>(() => {});
        return { decision: mode === 'allow' ? 'allow' : 'deny', rule: 'fixture/v1', reason: 'host decision' };
      },
      async execute() { executions++; return { content: [{ type: 'text', text: 'counted' }] }; } });
    let turn = 0; const f = await toolLoopFixture(t, response => {
      if (++turn === 1) { toolReply(response, [{ id: 'call', name: 'check_write', args: {} }]); return; }
      beginSse(response); chatChunk(response, { role: 'assistant', content: 'done' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
    }, registry);
    const handle = f.send();
    if (mode === 'cancel') { await waitUntil(() => entered); handle.cancel(); }
    const result = await deadline(handle.done, 5000);
    assert.equal(executions, mode === 'allow' ? 1 : 0);
    if (mode === 'allow') {
      assert.equal(result.approvals![0]!.inspection?.decision, 'allow');
      assert.equal(result.approvals![0]!.status, 'approved');
      assert.deepEqual(f.store.load()[0]!.runs[0]!.approvals, result.approvals);
    } else assert.equal(result.approvals!.length, 0);
    assert.doesNotMatch(JSON.stringify(f.server.requests), /private policy error/);
  });
}

test('automatic policy approval must be saved before execution and cancellation prevents save-retry replay', async t => {
  const registry = new ToolRegistry(); let executions = 0;
  registry.register({ name: 'auto_write', version: '1', label: 'automatic write', description: 'isolated counter',
    parameters: Type.Object({}, { additionalProperties: false }), effect: 'write', approval: 'always', resources: ['counter'], timeoutMs: 1000,
    async inspectExecution() { return { decision: 'allow', rule: 'fixture/v1', reason: 'automatic host policy' }; },
    async execute() { executions++; return { content: [{ type: 'text', text: 'counted' }] }; } });
  const f = await toolLoopFixture(t, response => toolReply(response, [{ id: 'w', name: 'auto_write', args: {} }]), registry);
  f.faults.exec("CREATE TRIGGER fail_auto BEFORE UPDATE ON tool_calls WHEN NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  const handle = f.send(); await waitUntil(() => f.service.getSnapshot(f.sessionId).saveState.status === 'failed');
  assert.equal(executions, 0); assert.equal(f.store.load()[0]!.runs[0]!.approvals![0]!.status, 'pending');
  handle.cancel(); await deadline(handle.done, 5000); f.faults.exec('DROP TRIGGER fail_auto'); f.service.retrySave(f.sessionId);
  assert.equal(executions, 0); assert.equal(f.service.getSnapshot(f.sessionId).saveState.status, 'saved');
});
