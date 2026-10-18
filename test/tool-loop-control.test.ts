import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { ToolRegistry } from '../src/index.js';
import { toolLoopFixture, toolReply } from './helpers/tool-loop.js';
import { chatReply, deadline } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';

function fixtureRegistry(execute: (signal: AbortSignal) => Promise<string>, timeoutMs = 1000) {
  const registry = new ToolRegistry();
  registry.register({ name: 'fixture', version: '1', label: 'fixture', description: 'fixture',
    parameters: Type.Object({}, { additionalProperties: false }), effect: 'read', approval: 'never',
    resources: [], timeoutMs, async execute(_args, context) { return { content: [{ type: 'text', text: await execute(context.signal) }] }; } });
  return registry;
}

test('failed intent commit blocks execution until save-only retry', async t => {
  let actions = 0;
  const f = await toolLoopFixture(t, (response, captured) => {
    if (!(captured.body.messages as { role: string }[]).some(message => message.role === 'tool')) {
      toolReply(response, [{ id: 'call', name: 'fixture', args: {} }]);
    } else chatReply(response);
  }, fixtureRegistry(async () => { actions++; return 'ok'; }));
  f.faults.exec(`CREATE TRIGGER fail_intent BEFORE UPDATE ON tool_calls WHEN NEW.status = 'running'
    BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
  const handle = f.send();
  await waitUntil(() => f.service.getSnapshot(f.sessionId).saveState.status === 'failed');
  assert.equal(actions, 0); assert.equal(f.server.requests.length, 1);
  f.faults.exec('DROP TRIGGER fail_intent'); f.service.retrySave(f.sessionId);
  assert.equal((await deadline(handle.done, 5000)).status, 'completed'); assert.equal(actions, 1);
});

test('failed result commit pauses model continuation and save retry never repeats the tool', async t => {
  let actions = 0;
  const f = await toolLoopFixture(t, (response, captured) => {
    if (!(captured.body.messages as { role: string }[]).some(message => message.role === 'tool')) {
      toolReply(response, [{ id: 'call', name: 'fixture', args: {} }]);
    } else chatReply(response);
  }, fixtureRegistry(async () => { actions++; return 'ok'; }));
  f.faults.exec(`CREATE TRIGGER fail_result BEFORE INSERT ON run_messages
    WHEN json_extract(NEW.record, '$.message.role') = 'toolResult' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
  const handle = f.send();
  await waitUntil(() => f.service.getSnapshot(f.sessionId).saveState.status === 'failed');
  assert.equal(actions, 1); assert.equal(f.server.requests.length, 1);
  f.faults.exec('DROP TRIGGER fail_result'); f.service.retrySave(f.sessionId);
  assert.equal((await deadline(handle.done, 5000)).status, 'completed'); assert.equal(actions, 1);
});

test('cancel reaches the running read tool, prevents later requests and ignores late completion', async t => {
  let started = false; let observed = false; let complete!: () => void;
  const registry = fixtureRegistry(async signal => {
    started = true; signal.addEventListener('abort', () => { observed = true; });
    await new Promise<void>(resolve => { complete = resolve; }); return 'late';
  });
  const f = await toolLoopFixture(t, response => toolReply(response, [{ id: 'call', name: 'fixture', args: {} }]), registry);
  const handle = f.send(); await waitUntil(() => started); handle.cancel();
  const result = await deadline(handle.done, 5000);
  assert.equal(result.status, 'cancelled'); assert.equal(observed, true);
  assert.equal(f.server.requests.length, 1); assert.equal(result.toolCalls![0]!.status, 'cancelled');
  complete(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.service.getSnapshot(f.sessionId).runs[0], result);
});

test('read-tool timeout is a recorded error and the model can explain the failure', async t => {
  const registry = fixtureRegistry(async signal => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return 'late';
  }, 15);
  const f = await toolLoopFixture(t, (response, captured) => {
    if (!(captured.body.messages as { role: string }[]).some(message => message.role === 'tool')) {
      toolReply(response, [{ id: 'call', name: 'fixture', args: {} }]);
    } else chatReply(response);
  }, registry);
  const result = await deadline(f.send().done, 5000);
  assert.equal(result.status, 'completed'); const call = result.toolCalls![0]!;
  assert.ok(call.status === 'failed'); assert.equal(call.error.code, 'TIMEOUT');
});

test('run turn limits prevent endless model/tool loops', async t => {
  let id = 0;
  const f = await toolLoopFixture(t, response => toolReply(response,
    [{ id: `call-${++id}`, name: 'add_numbers', args: { a: 1, b: 1 } }]), undefined, { maxModelTurns: 2 });
  const result = await deadline(f.send().done, 5000);
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'RUN_LIMIT');
  assert.equal(f.server.requests.length, 2); assert.equal(result.toolCalls!.length, 2);
});

test('call-count limits reject the full extra batch without invoking handlers', async t => {
  const f = await toolLoopFixture(t, response => toolReply(response, [
    { id: 'one', name: 'add_numbers', args: { a: 1, b: 1 } },
    { id: 'two', name: 'add_numbers', args: { a: 2, b: 2 } },
  ]), undefined, { maxToolCalls: 1 });
  const result = await deadline(f.send().done, 5000);
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'RUN_LIMIT');
  assert.equal(f.server.requests.length, 1);
  assert.ok(result.toolCalls!.every(call => call.status === 'rejected'));
});
