import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { McpConnectionManager, mcpConnectionIdentity, mcpToolAlias, toolSnapshot } from '../src/index.js';
import { lifecycleFixture, catalogTool } from './helpers/mcp-connection.js';
import { registryMemory } from './helpers/mcp-registry.js';
import { mcpConfig } from './helpers/mcp.js';
import { mcpHttpFixture } from './helpers/mcp-http.js';
import { McpInvocationGate } from '../src/mcp/invocation-gate.js';
import { guardedMcpFetch } from '../src/mcp/connection-fetch.js';
const signal = new AbortController().signal;
const scope = () => ({ sessionId: 'chat', runId: 'run', signal, authorize: () => true });
const context = () => ({ sessionId: 'chat', runId: 'run', turnId: 'turn', toolCallId: 'call', signal,
  approval: { approvalId: 'approval', expiresAt: Date.now() + 10_000 } });

test('tool aliases remain stable across catalog revisions and distinct for ambiguous raw names', () => {
  assert.notEqual(mcpToolAlias('a/b', 'c'), mcpToolAlias('a', 'b/c'));
  assert.match(mcpToolAlias('a'.repeat(1000), '非 ASCII'), /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
  assert.equal(mcpToolAlias('service', 'op'), mcpToolAlias('service', 'op'));
});

test('MCP bindings reject foreign runs, missing receipts and changed schemas without dispatch', async t => {
  const f = await lifecycleFixture(t); f.approve(); await f.manager.open('chat', f.ref);
  const tool = f.manager.bindTools(scope(), f.ref)[0]!;
  await assert.rejects(tool.execute({}, { ...context(), runId: 'other' }), { code: 'DENIED' });
  const { approval: _, ...missing } = context();
  await assert.rejects(tool.execute({}, missing), { code: 'DENIED' });
  assert.throws(() => toolSnapshot({ ...tool, parameters: { type: 'object', properties: { changed: { type: 'string' } }, additionalProperties: false } }));
  assert.equal(f.messages.flat().filter(m => 'method' in m && m.method === 'tools/call').length, 0);
});

test('unsupported schemas and tool deny policy never enter the executable registry', async t => {
  const f = await lifecycleFixture(t);
  f.setTools([{ ...catalogTool(), inputSchema: { type: 'object', properties: {}, additionalProperties: false, dependentRequired: {} } }]);
  f.approve(); await f.manager.open('chat', f.ref); assert.deepEqual(f.manager.bindTools(scope(), f.ref), []);
  const next = mcpConnectionIdentity(f.registry.update(f.ref, { policy: { connect: 'ask', tools: 'deny', resources: 'deny' } }).config);
  f.registry.approveConnection(next); await f.manager.reconnect('chat', next); assert.deepEqual(f.manager.bindTools(scope(), next), []);
});

test('real Pi stdio and HTTP tool calls reuse the same host-bound execution contract', async t => {
  const http = await mcpHttpFixture(t);
  for (const transport of [{ type: 'stdio', command: process.execPath, args: [resolve('dist/test/fixtures/mcp-service.js')] },
    { type: 'streamable-http', url: http.url }]) {
    const { registry } = registryMemory(t); const ref = mcpConnectionIdentity(registry.register(mcpConfig({ transport })).config);
    registry.approveConnection(ref); const manager = new McpConnectionManager(registry); t.after(() => manager.dispose());
    await manager.open('chat', ref); const tool = manager.bindTools(scope(), ref)[0]!;
    const result = await tool.execute({}, context()); assert.equal(result.effectState, 'committed');
    assert.match(JSON.stringify(result.content), /tool executed/);
    await assert.rejects(tool.execute({}, context()), { code: 'DENIED' });
  }
  assert.equal(http.requests.filter(r => r.rpc === 'tools/call').length, 1);
});

test('late HTTP credential resolution rechecks the invocation and never posts after cancellation', async t => {
  const http = await mcpHttpFixture(t, { bearer: 'fixture' }); const { registry } = registryMemory(t);
  const ref = mcpConnectionIdentity(registry.register(mcpConfig({ transport: { type: 'streamable-http', url: http.url,
    auth: { type: 'bearer', credentialRef: 'env:FIXTURE' } } })).config); registry.approveConnection(ref);
  let delay = false, release!: () => void;
  const manager = new McpConnectionManager(registry, { credentials: async () => {
    if (delay) await new Promise<void>(resolve => { release = resolve; }); return 'fixture';
  } }); t.after(() => manager.dispose()); await manager.open('chat', ref);
  const controller = new AbortController();
  const tool = manager.bindTools({ ...scope(), signal: controller.signal }, ref)[0]!;
  delay = true; const running = tool.execute({}, context());
  await new Promise(resolve => setTimeout(resolve, 10)); controller.abort();
  await assert.rejects(running); release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(http.requests.filter(r => r.rpc === 'tools/call').length, 0);
});

test('HTTP auth retries cannot resend the same tools/call, and late sends cannot inherit a later invocation', async () => {
  const gate = new McpInvocationGate(); const end = gate.begin(() => {});
  gate.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call' }); let sent = 0;
  const fetch = guardedMcpFetch(() => true, { signal, check() {}, checkToolRequest: id => gate.beforeHttp(id) },
    async () => { sent++; return new Response('{}'); }, true);
  const init = { method: 'POST', body: JSON.stringify({ id: 1, method: 'tools/call' }) };
  await fetch('http://127.0.0.1/mcp', init);
  await assert.rejects(fetch('http://127.0.0.1/mcp', init)); assert.equal(sent, 1);
  end(); const finish = gate.begin(() => {}); gate.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call' });
  await assert.rejects(fetch('http://127.0.0.1/mcp', init)); finish(); assert.equal(sent, 1);
});
