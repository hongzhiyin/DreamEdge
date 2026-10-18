import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { ToolRegistry, PiRuntime, toolSnapshot } from '../src/index.js';
import { toolLoopFixture, toolReply } from './helpers/tool-loop.js';
import { chatReply, deadline, connection, request } from './helpers/server.js';

for (const kind of ['unknown', 'invalid', 'throw'] as const) {
  test(`tool loop ${kind}: publishes a controlled error and continues without an unintended action`, async t => {
    let actions = 0; const registry = new ToolRegistry();
    registry.register({ name: 'fixture', version: '1', label: 'fixture', description: 'fixture',
      parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
      effect: 'read', approval: 'never', resources: [], timeoutMs: 1000,
      async execute() { actions++; throw new Error('private callback fixture-key'); } });
    const f = await toolLoopFixture(t, (response, captured) => {
      if (!(captured.body.messages as { role: string }[]).some(message => message.role === 'tool')) {
        toolReply(response, [{ id: 'call', name: kind === 'unknown' ? 'missing' : 'fixture',
          args: { value: kind === 'invalid' ? 'bad' : 1 } }]);
      } else chatReply(response);
    }, registry);
    const result = await deadline(f.send().done, 5000);
    assert.equal(result.status, 'completed', result.error?.message);
    assert.equal(actions, kind === 'throw' ? 1 : 0);
    assert.equal(result.toolCalls![0]!.status, kind === 'throw' ? 'failed' : 'rejected');
    assert.ok(!JSON.stringify(result).includes('private callback'));
    const wire = f.server.requests[1]!.body.messages as { role: string; content: string }[];
    assert.ok(!wire.find(message => message.role === 'tool')!.content.includes('fixture-key'));
  });
}

test('tool runtime rejects write tools and unavailable versions before credential access', async () => {
  let actions = 0; let credentialsRead = 0; const registry = new ToolRegistry();
  registry.register({ name: 'write', version: '1', label: 'write', description: 'write',
    parameters: Type.Object({}, { additionalProperties: false }), effect: 'write', approval: 'always',
    resources: ['fixture'], timeoutMs: 1000, async execute() { actions++; return { content: [] }; } });
  const config = connection('http://127.0.0.1:1', { thinkingLevel: 'high',
    toolCalling: { supported: true, supportedThinkingLevels: ['high'] } });
  const runtime = new PiRuntime(config, async () => { credentialsRead++; return 'fixture-key'; }, { registry });
  const input = { ...request(), checkpoint: async () => true };
  const denied = await runtime.start({ ...input, tools: registry.snapshots() }).done;
  assert.equal(denied.error?.code, 'TOOLS_NOT_ENABLED');
  const snapshot = toolSnapshot({ ...registry.snapshots()[0]!, version: '2' });
  assert.equal((await runtime.start({ ...input, tools: [snapshot] }).done).status, 'failed');
  assert.equal(credentialsRead, 0); assert.equal(actions, 0);
});

test('truncated tool parameters cannot execute even if the salvaged object matches the schema', async t => {
  let actions = 0; const registry = new ToolRegistry();
  registry.register({ name: 'fixture', version: '1', label: 'fixture', description: 'fixture',
    parameters: Type.Object({}, { additionalProperties: false }), effect: 'read', approval: 'never',
    resources: [], timeoutMs: 1000, async execute() { actions++; return { content: [] }; } });
  const f = await toolLoopFixture(t, response => toolReply(response, [{ id: 'call', name: 'fixture', args: {} }], 'length'), registry);
  const result = await deadline(f.send().done, 5000);
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'OUTPUT_LIMIT');
  assert.equal(actions, 0); assert.equal(f.server.requests.length, 1);
});

test('duplicate model call IDs fail before executing the second action', async t => {
  let actions = 0; const registry = new ToolRegistry();
  registry.register({ name: 'fixture', version: '1', label: 'fixture', description: 'fixture',
    parameters: Type.Object({}, { additionalProperties: false }), effect: 'read', approval: 'never',
    resources: [], timeoutMs: 1000, async execute() { actions++; return { content: [{ type: 'text', text: 'ok' }] }; } });
  const f = await toolLoopFixture(t, response => toolReply(response, [{ id: 'same', name: 'fixture', args: {} }]), registry);
  const result = await deadline(f.send().done, 5000);
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'UNEXPECTED_RESPONSE');
  assert.equal(actions, 1); assert.equal(f.server.requests.length, 2);
});
