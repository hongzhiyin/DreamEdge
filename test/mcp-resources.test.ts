import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpRunFixture } from './helpers/mcp-run.js';
import { deadline } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';
import { modelDestination } from '../src/index.js';
import { mcpResourceResult } from '../src/mcp/resource-result.js';
import type { McpResourceReceipt } from '../src/mcp/resource-result.js';

const resource = async (uri: string) => ({ contents: [{ uri, mimeType: 'text/plain', text: 'Selected resource text' }] });
test('resources/read uses durable confirmation, records source/recipient and does not prefetch other URIs', async t => {
  const f = await mcpRunFixture(t, { resource }); const h = f.send(); await f.pending();
  assert.equal(f.reads(), 0); assert.equal(f.actions(), 0); await f.decide();
  const result = await deadline(h.done, 5000); assert.equal(result.status, 'completed'); assert.equal(f.reads(), 1);
  const call = result.toolCalls![0]!; assert.equal(call.effect, 'read'); assert.equal(call.status, 'succeeded');
  if (call.status !== 'succeeded') throw 0;
  const receipt = (call.result.details as unknown as { mcpResource: McpResourceReceipt }).mcpResource;
  assert.equal(receipt.uri, 'fixture://selected'); assert.equal(receipt.origin.serverId, 'generic');
  assert.deepEqual(receipt.destination, modelDestination(f.config)); assert.match(receipt.contentDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.store.load()[0]!.runs[0]!.toolCalls, result.toolCalls);
  const calls = f.messages.flat().filter(m => 'method' in m && m.method === 'resources/read');
  assert.equal(calls.length, 1); assert.equal('params' in calls[0]! && (calls[0].params as { uri: string }).uri, 'fixture://selected');
});

test('resource confirmation rejection and cancellation during read do not become unknown writes', async t => {
  for (const mode of ['reject', 'cancel'] as const) {
    const f = await mcpRunFixture(t, { resource: mode === 'cancel' ? () => new Promise(() => {}) : resource });
    const h = f.send(); await f.pending();
    if (mode === 'reject') await f.decide('reject');
    else { await f.decide(); await waitUntil(() => f.reads() === 1); h.cancel(); }
    const result = await deadline(h.done, 5000);
    assert.equal(f.actions(), 0); assert.notEqual(result.toolCalls![0]!.status, 'outcome_unknown');
    assert.equal(f.reads(), mode === 'reject' ? 0 : 1);
  }
});

test('resource intent and result save failures pause without refetching', async t => {
  for (const phase of ['intent', 'result']) {
    const f = await mcpRunFixture(t, { resource });
    f.faults.exec(phase === 'intent' ? `CREATE TRIGGER fail_boundary BEFORE UPDATE ON tool_calls WHEN NEW.status='running'
      BEGIN SELECT RAISE(ABORT,'fixture'); END` : `CREATE TRIGGER fail_boundary BEFORE INSERT ON run_messages
      WHEN json_extract(NEW.record,'$.message.role')='toolResult' BEGIN SELECT RAISE(ABORT,'fixture'); END`);
    const h = f.send(); await f.decide(); await waitUntil(() => f.snapshot().saveState.status === 'failed');
    assert.equal(f.reads(), phase === 'intent' ? 0 : 1); assert.equal(f.server.requests.length, 1);
    f.faults.exec('DROP TRIGGER fail_boundary'); f.service.retrySave(f.sessionId);
    assert.equal((await deadline(h.done, 5000)).status, 'completed'); assert.equal(f.reads(), 1);
  }
});

test('large resources and malformed blobs fail without passing raw content to the model', async t => {
  for (const contents of [[{ uri: 'fixture://selected', text: 'secret'.repeat(100_000) }],
    [{ uri: 'fixture://selected', mimeType: 'image/png', blob: 'invalid base64!' }]]) {
    const f = await mcpRunFixture(t, { resource: async () => ({ contents }) }); const h = f.send(); await f.decide();
    const result = await deadline(h.done, 5000); assert.equal(result.toolCalls![0]!.status, 'failed');
    assert.ok(!JSON.stringify(result).includes('invalid base64')); assert.ok(!JSON.stringify(result).includes('secretsecret'));
    assert.equal(f.reads(), 1);
  }
});

test('Pi converts resource text/images and represents binary without opening links or creating files', async t => {
  const f = await mcpRunFixture(t, { resource }); const h = f.send(); await f.pending();
  const origin = f.snapshot().runs[0]!.toolsSnapshot!.find(t => t.origin?.kind === 'mcp-resource')!.origin!;
  const result = mcpResourceResult(origin, 'fixture://selected', modelDestination(f.config), { contents: [
    { uri: 'fixture://selected', text: '<script>untrusted text</script>' },
    { uri: 'fixture://image', mimeType: 'image/png', blob: 'YWJj' },
    { uri: 'https://example.invalid/blob', mimeType: 'application/octet-stream', blob: 'YWJj' },
  ] });
  assert.equal(result.content[0]!.type, 'text'); assert.equal(result.content[1]!.type, 'image');
  assert.match(JSON.stringify(result.content[2]), /omitted/); assert.equal(f.reads(), 0);
  h.cancel(); await h.done;
});
