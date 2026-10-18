import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { McpAbortError, McpTimeoutError, McpConnectionClosedError, McpError, toLlmContent } from '@earendil-works/pi-mcp';
import { mcpFixture } from './helpers/mcp.js';
const tool = (name: string) => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } });

test('Pi negotiates the fixed baseline and paginates tools/resources using its own transport', async t => {
  const f = await mcpFixture(t, { handle: async (request, reply) => {
    const params = request.params as { cursor?: string; uri?: string };
    if (request.method === 'tools/list') await reply(params?.cursor ? { tools: [tool('second')] } : { tools: [tool('first')], nextCursor: 'next' });
    if (request.method === 'resources/list') await reply({ resources: [{ uri: 'fixture://item', name: 'item', mimeType: 'text/plain' }] });
    if (request.method === 'resources/read') await reply({ contents: [{ uri: params.uri, text: 'fixture resource' }] });
  } });
  const result = await f.connect(); assert.equal(result.protocolVersion, '2025-11-25'); assert.equal(f.client.connectionState, 'connected');
  assert.deepEqual((f.messages[0] as { params: { capabilities: unknown } }).params.capabilities, {});
  assert.ok(f.messages.some(m => 'method' in m && m.method === 'notifications/initialized'));
  assert.deepEqual((await f.client.listTools()).map(t => t.name), ['first', 'second']);
  assert.equal((await f.client.listResources())[0]?.uri, 'fixture://item');
  const resource = (await f.client.readResource('fixture://item')).contents[0]!;
  assert.ok('text' in resource); assert.equal(resource.text, 'fixture resource');
});

test('supported older protocol is explicitly reported, not relabeled as the requested version', async t => {
  const f = await mcpFixture(t, { version: '2025-06-18' });
  assert.equal((await f.connect()).protocolVersion, '2025-06-18'); assert.equal(f.client.protocolVersion, '2025-06-18');
});

test('unsupported negotiated version closes the connection before tools or initialization notification', async t => {
  const f = await mcpFixture(t, { version: '2099-01-01' });
  await assert.rejects(f.connect(), /unsupported protocol version/); assert.equal(f.client.connectionState, 'closed');
  assert.equal(f.messages.filter(m => 'method' in m && m.method !== 'initialize').length, 0);
  await assert.rejects(f.client.listTools(), /not connected|closed/);
});

test('Pi detects repeated pagination cursors instead of silently accepting an incomplete catalog', async t => {
  const f = await mcpFixture(t, { handle: async (_request, reply) => { await reply({ tools: [tool('item')], nextCursor: 'repeated' }); } });
  await f.connect(); await assert.rejects(f.client.listTools(), /duplicate cursor/);
  assert.equal(f.messages.filter(m => 'method' in m && m.method === 'tools/list').length, 2);
});

test('tool-level isError and structured content are distinct from JSON-RPC failures', async t => {
  const f = await mcpFixture(t, { handle: async (request, reply) => {
    if (request.method === 'tools/call') await reply({ isError: true, content: [{ type: 'text', text: 'operation rejected' }], structuredContent: { code: 'CONFLICT' } });
    else await f.pair.server.send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported method' } });
  } });
  await f.connect(); const result = await f.client.callTool('operation', {});
  assert.equal(result.isError, true); assert.deepEqual(result.structuredContent, { code: 'CONFLICT' });
  assert.deepEqual(toLlmContent(result), [{ type: 'text', text: 'operation rejected' }]);
  await assert.rejects(f.client.request('fixture/unsupported'), (e: unknown) => e instanceof McpError && e.code === -32601);
});

test('Pi rejects malformed results without pretending there is a usable tool list', async t => {
  const f = await mcpFixture(t, { handle: async (_request, reply) => { await reply({ tools: 'invalid' }); } });
  await f.connect(); await assert.rejects(f.client.listTools(), /invalid|Invalid/);
});

test('abort notifies the original call, ignores late result and does not replay it', async t => {
  const controller = new AbortController(); let late: ((value: unknown) => Promise<void>) | undefined;
  const f = await mcpFixture(t, { handle: async (request, reply) => {
    if (request.method === 'tools/call') { late = reply; controller.abort(); } else await reply({});
  } });
  await f.connect(); await assert.rejects(f.client.callTool('slow', {}, { signal: controller.signal }), McpAbortError);
  await setImmediate(); const call = f.messages.find(m => 'method' in m && m.method === 'tools/call')!;
  const cancel = f.messages.find(m => 'method' in m && m.method === 'notifications/cancelled')!;
  assert.equal((cancel as { params: { requestId: unknown } }).params.requestId, (call as { id: unknown }).id);
  await late!({ content: [{ type: 'text', text: 'late' }] }); await f.client.ping();
  assert.equal(f.messages.filter(m => 'method' in m && m.method === 'tools/call').length, 1);
});

test('request timeout rejects once, sends cancellation and does not retry a tool', async t => {
  const f = await mcpFixture(t); await f.connect();
  await assert.rejects(f.client.callTool('slow', {}, { timeoutMs: 15 }), McpTimeoutError); await setImmediate();
  assert.equal(f.messages.filter(m => 'method' in m && m.method === 'tools/call').length, 1);
  assert.equal(f.messages.filter(m => 'method' in m && m.method === 'notifications/cancelled').length, 1);
});

test('transport close rejects pending work and reports one close event', async t => {
  let received!: () => void; const seen = new Promise<void>(r => { received = r; });
  const f = await mcpFixture(t, { handle: () => { received(); } }); await f.connect(); let closes = 0; f.client.onClose(() => closes++);
  const pending = f.client.callTool('slow', {}); const rejected = assert.rejects(pending, McpConnectionClosedError);
  await seen; await f.pair.server.close(); await rejected; await f.client.close(); assert.equal(closes, 1);
});

test('SDK list-change notifications and content conversion remain available without new algorithms', async t => {
  const f = await mcpFixture(t); await f.connect(); let changed = 0;
  const dispose = f.client.onNotification('notifications/tools/list_changed', () => changed++);
  await f.pair.server.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); await setImmediate(); assert.equal(changed, 1); dispose();
  assert.deepEqual(toLlmContent({ content: [], structuredContent: { value: 1 } }), [{ type: 'text', text: '{\n  "value": 1\n}' }]);
  const audio = toLlmContent({ content: [{ type: 'audio', data: 'AA==', mimeType: 'audio/wav' }] });
  assert.match((audio[0] as { text: string }).text, /omitted/);
});
