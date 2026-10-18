import assert from 'node:assert/strict';
import test from 'node:test';
import { builtInTools, SqliteSessionStore } from '../src/index.js';
import { toolLoopFixture, toolReply } from './helpers/tool-loop.js';
import { chatReply, deadline } from './helpers/server.js';
import { ToolRegistry } from '../src/index.js';
import { Type } from 'typebox';
import { setTimeout as delay } from 'node:timers/promises';

test('Pi executes a registered addition, persists its actual result and continues with high thinking', async t => {
  const f = await toolLoopFixture(t, (response, request) => {
    const messages = request.body.messages as { role: string; content: string }[];
    if (!messages.some(message => message.role === 'tool')) toolReply(response, [{ id: 'sum', name: 'add_numbers', args: { a: 3, b: 5 } }]);
    else chatReply(response);
  });
  const result = await deadline(f.send().done, 5000);
  assert.equal(result.status, 'completed', result.error?.message);
  assert.equal(f.server.requests.length, 2);
  assert.equal(result.toolCalls![0]!.status, 'succeeded');
  const call = result.toolCalls![0]!;
  assert.ok(call.status === 'succeeded'); assert.equal(call.result.content[0]?.type, 'text');
  assert.deepEqual(call.result.details, { sum: 8 });
  const wire = f.server.requests[1]!.body.messages as { role: string; content: string; reasoning_content?: string }[];
  assert.equal(wire.filter(message => message.role === 'user').length, 1);
  assert.equal(wire.find(message => message.role === 'tool')!.content, '8');
  assert.equal(wire.find(message => message.role === 'assistant')!.reasoning_content, 'tool reasoning');
  assert.equal(f.server.requests[1]!.body.reasoning_effort, 'high');
  assert.equal(result.text, 'Hello world');
  assert.deepEqual(f.store.load()[0]!.runs[0], result);
});

test('time then addition spans several native model turns and survives a SQLite restart', async t => {
  const registry = builtInTools(() => new Date('2026-10-13T00:00:00Z'));
  const f = await toolLoopFixture(t, (response, request) => {
    const results = (request.body.messages as { role: string; content: string }[]).filter(message => message.role === 'tool');
    if (!results.length) toolReply(response, [{ id: 'clock', name: 'get_current_time', args: {} }]);
    else if (results.length === 1) toolReply(response, [{ id: 'sum', name: 'add_numbers', args: { a: Number(results[0]!.content.slice(8, 10)), b: 1 } }]);
    else chatReply(response);
  }, registry);
  const result = await deadline(f.send().done, 5000);
  assert.equal(result.status, 'completed', result.error?.message); assert.equal(f.server.requests.length, 3);
  assert.deepEqual(result.toolCalls!.map(call => call.status), ['succeeded', 'succeeded']);
  const sum = result.toolCalls![1]!; assert.ok(sum.status === 'succeeded'); assert.deepEqual(sum.result.details, { sum: 14 });
  const messages = result.transcript!.map(entry => entry.message);
  assert.equal(messages.filter(message => message.role === 'assistant').length, 3);
  assert.equal(messages.filter(message => message.role === 'toolResult').length, 2);
  await f.service.dispose(); const reopened = new SqliteSessionStore(f.path);
  t.after(() => reopened.close()); assert.deepEqual(reopened.load()[0]!.runs[0], result);
});

test('tools within one model response execute serially after the previous result is committed', async t => {
  const order: string[] = []; let inspect!: () => void; const registry = new ToolRegistry();
  registry.register({ name: 'fixture', version: '1', label: 'fixture', description: 'fixture',
    parameters: Type.Object({ value: Type.Number() }, { additionalProperties: false }), effect: 'read',
    approval: 'never', resources: [], timeoutMs: 1000, async execute(args) {
      order.push(`start-${args.value}`);
      if (args.value === 1) await delay(10); else inspect();
      order.push(`end-${args.value}`); return { content: [{ type: 'text', text: String(args.value) }] };
    } });
  const f = await toolLoopFixture(t, (response, captured) => {
    if (!(captured.body.messages as { role: string }[]).some(message => message.role === 'tool')) toolReply(response, [
      { id: 'one', name: 'fixture', args: { value: 1 } }, { id: 'two', name: 'fixture', args: { value: 2 } },
    ]); else chatReply(response);
  }, registry);
  inspect = () => {
    const run = f.store.load()[0]!.runs[0]!;
    assert.equal(run.toolCalls![0]!.status, 'succeeded');
    assert.equal(run.transcript!.filter(entry => entry.message.role === 'toolResult').length, 1);
  };
  assert.equal((await deadline(f.send().done, 5000)).status, 'completed');
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});
