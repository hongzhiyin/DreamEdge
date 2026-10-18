import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { ToolRegistry, argumentsDigest, PiRuntime } from '../src/index.js';
import { ToolExecutor } from '../src/runtime/tool-executor.js';
import type { ToolCallRecord } from '../src/index.js';
import { connection, request } from './helpers/server.js';

test('registered callbacks and schemas remain fixed despite edits to the original definition', async () => {
  const registry = new ToolRegistry(); const parameters = Type.Object({}, { additionalProperties: false });
  const definition = { name: 'fixture', version: '1', label: 'fixture', description: 'fixture', parameters,
    effect: 'read' as const, approval: 'never' as const, resources: [], timeoutMs: 1000,
    async execute() { return { content: [{ type: 'text' as const, text: 'original' }] }; } };
  registry.register(definition); const snapshot = registry.snapshots()[0]!;
  definition.execute = async () => ({ content: [{ type: 'text', text: 'changed' }] });
  Object.assign(parameters, { description: 'changed' });
  assert.throws(() => Object.assign(registry.resolve(snapshot), { execute: definition.execute }), TypeError);
  const result = await registry.resolve(snapshot).execute({}, { sessionId: 's', runId: 'r', turnId: 't',
    toolCallId: 'c', signal: new AbortController().signal });
  assert.deepEqual(result.content, [{ type: 'text', text: 'original' }]);
  assert.throws(() => registry.register(definition), { code: 'DUPLICATE_TOOL' });
});

test('executor coalesces duplicate invocations and rejects conflicting identities', async () => {
  let calls = 0; let intents = 0; const registry = new ToolRegistry();
  registry.register({ name: 'fixture', version: '1', label: 'fixture', description: 'fixture',
    parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }),
    effect: 'read', approval: 'never', resources: [], timeoutMs: 1000,
    async execute(args) { calls++; await Promise.resolve(); return { content: [{ type: 'text', text: String(args.value) }] }; } });
  const snapshot = registry.snapshots()[0]!;
  const call: ToolCallRecord = { sessionId: 's', runId: 'r', turnId: 't', toolCallId: 'c', toolName: 'fixture',
    toolVersion: '1', args: { value: 7 }, argsDigest: argumentsDigest({ value: 7 }), effect: 'read', approval: 'never',
    createdAt: 100, status: 'requested' };
  const executor = new ToolExecutor(registry, new AbortController().signal, async call => {
    intents++; return { ...call, status: 'running', startedAt: Date.now() };
  });
  const [first, second] = await Promise.all([executor.execute(call, snapshot), executor.execute(call, snapshot)]);
  assert.equal(first, second); assert.equal(first.status, 'succeeded');
  assert.equal(await executor.execute(call, snapshot), first); assert.equal(calls, 1); assert.equal(intents, 1);
  assert.throws(() => executor.execute({ ...call, args: { value: 8 }, argsDigest: argumentsDigest({ value: 8 }) }, snapshot),
    { code: 'UNEXPECTED_RESPONSE' });
});

test('unsupported model tool capability cannot read credentials or reach dispatch', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'fixture', version: '1', label: 'fixture', description: 'fixture',
    parameters: Type.Object({}, { additionalProperties: false }), effect: 'read', approval: 'never',
    resources: [], timeoutMs: 1000, async execute() { throw new Error('Never execute'); } });
  let credentials = 0;
  const runtime = new PiRuntime(connection('http://127.0.0.1:1'), async () => { credentials++; return 'fixture-key'; }, { registry });
  const result = await runtime.start({ ...request(), tools: registry.snapshots(), checkpoint: async () => true }).done;
  assert.equal(result.status, 'failed'); assert.equal(credentials, 0);
});
