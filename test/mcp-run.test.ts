import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpRunFixture } from './helpers/mcp-run.js';
import { deadline } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';
import { SqliteSessionStore } from '../src/index.js';

test('Pi MCP calls use the frozen run registry, durable approval and native tool loop', async t => {
  const f = await mcpRunFixture(t); const handle = f.send();
  const approval = await f.pending(); assert.equal(f.actions(), 0);
  const frozen = f.snapshot().runs[0]!.toolsSnapshot!;
  assert.equal(frozen[0]!.origin?.toolName, 'calculate'); assert.equal(frozen[0]!.approval, 'always');
  assert.equal(approval.toolVersion, frozen[0]!.version);
  await f.decide();
  const result = await deadline(handle.done, 5000);
  assert.equal(result.status, 'completed'); assert.equal(f.actions(), 1);
  assert.equal(result.toolCalls![0]!.status, 'succeeded');
  assert.deepEqual(result.toolsSnapshot, frozen);
  assert.equal(f.server.requests.length, 2);
  const stored = new SqliteSessionStore(f.path);
  try {
    const loaded = stored.load()[0]!.runs[0]!;
    assert.deepEqual(loaded.toolsSnapshot, frozen);
    const details = loaded.transcript!.find(e => e.message.role === 'toolResult')!.message;
    assert.equal(details.role, 'toolResult');
    assert.match(JSON.stringify(details), /structuredContent/);
  } finally { stored.close(); }
});

test('MCP rejection and cancellation while awaiting approval dispatch nothing', async t => {
  for (const action of ['reject', 'cancel'] as const) {
    const f = await mcpRunFixture(t); const h = f.send(); await f.pending();
    if (action === 'reject') await f.decide('reject'); else h.cancel();
    await deadline(h.done, 5000); assert.equal(f.actions(), 0);
  }
});

test('MCP config revocation, catalog refresh and reconnect invalidate pending execution', async t => {
  for (const change of ['revoke', 'refresh', 'reconnect'] as const) {
    const f = await mcpRunFixture(t); const h = f.send(); await f.pending();
    if (change === 'revoke') f.registry.revoke(f.ref);
    else if (change === 'refresh') await f.manager.refresh(f.sessionId, 'generic');
    else await f.manager.reconnect(f.sessionId, f.ref);
    await f.decide(); const result = await deadline(h.done, 5000);
    assert.equal(f.actions(), 0); const call = result.toolCalls![0]!;
    assert.equal(call.status, 'failed'); assert.equal('error' in call && call.error.code, 'DENIED');
  }
});

test('MCP remote isError preserves content and structured output, stops as unknown and cannot retry', async t => {
  const f = await mcpRunFixture(t, { operation: async () => ({ isError: true,
    content: [{ type: 'text', text: 'partial remote failure' }], structuredContent: { applied: 1 } }) });
  const h = f.send(); await f.decide(); const result = await deadline(h.done, 5000);
  assert.equal(f.actions(), 1); assert.equal(result.toolCalls![0]!.status, 'outcome_unknown');
  assert.equal(f.server.requests.length, 1);
  const entry = result.transcript!.find(e => e.message.role === 'toolResult')!;
  assert.match(JSON.stringify(entry), /partial remote failure/); assert.match(JSON.stringify(entry), /"applied":1/);
  assert.throws(() => f.service.retry(f.sessionId), /未知/);
});

test('MCP cancellation after dispatch records unknown and sends Pi cancellation', async t => {
  const f = await mcpRunFixture(t, { operation: () => new Promise(() => {}) });
  const h = f.send(); await f.decide(); await waitUntil(() => f.actions() === 1); h.cancel();
  const result = await deadline(h.done, 5000);
  assert.equal(result.toolCalls![0]!.status, 'outcome_unknown');
  assert.ok(f.messages.flat().some(m => 'method' in m && m.method === 'notifications/cancelled'));
});

test('async preparation reserves session, deduplicates submission and cancels before model request', async t => {
  let finish!: () => void;
  const f = await mcpRunFixture(t, { select: () => new Promise<void>(resolve => { finish = resolve; }) });
  const h = f.send(); assert.equal(f.send(), h);
  assert.throws(() => f.service.send({ sessionId: f.sessionId, clientMessageId: 'two', text: 'second' }), /结算/);
  await waitUntil(() => !!finish); h.cancel(); assert.equal((await deadline(h.done, 5000)).status, 'cancelled');
  finish(); await Promise.resolve(); assert.equal(f.server.requests.length, 0); assert.equal(f.actions(), 0);
});
