import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { McpConnectionManager, mcpConnectionIdentity, modelDestination } from '../src/index.js';
import { mcpHttpFixture } from './helpers/mcp-http.js';
import { registryMemory } from './helpers/mcp-registry.js';
import { mcpConfig } from './helpers/mcp.js';
import { lifecycleFixture } from './helpers/mcp-connection.js';
import { connection } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';
const signal = new AbortController().signal;
const scope = () => ({ sessionId: 'chat', runId: 'run', signal, authorize: () => true });
const context = () => ({ sessionId: 'chat', runId: 'run', turnId: 'turn', toolCallId: 'read', signal,
  approval: { approvalId: 'approval', expiresAt: Date.now() + 10_000 } });
const destination = modelDestination(connection('https://model.invalid'));

test('Pi stdio and HTTP resources/read share the approved resource binding', async t => {
  const http = await mcpHttpFixture(t);
  for (const transport of [{ type: 'stdio', command: process.execPath, args: [resolve('dist/test/fixtures/mcp-service.js')] },
    { type: 'streamable-http', url: http.url }]) {
    const { registry } = registryMemory(t);
    const ref = mcpConnectionIdentity(registry.register(mcpConfig({ transport })).config); registry.approveConnection(ref);
    const manager = new McpConnectionManager(registry); t.after(() => manager.dispose()); await manager.open('chat', ref);
    const tools = manager.bindResources(scope(), ref, destination); assert.equal(tools.length, 1);
    await assert.rejects(tools[0]!.execute({ uri: 'file:///unlisted' }, context()));
    const result = await tools[0]!.execute({ uri: 'fixture://document' }, context());
    assert.match(JSON.stringify(result.content), /resource text/);
  }
  assert.equal(http.requests.filter(r => r.rpc === 'resources/read').length, 1);
});

test('resource deny policy emits no reader while tool deny does not block permitted resources', async t => {
  const f = await lifecycleFixture(t);
  let ref = mcpConnectionIdentity(f.registry.update(f.ref, { policy: { connect: 'ask', tools: 'deny', resources: 'ask' } }).config);
  f.registry.approveConnection(ref); await f.manager.open('chat', ref);
  assert.deepEqual(f.manager.bindTools(scope(), ref), []); assert.equal(f.manager.bindResources(scope(), ref, destination).length, 1);
  ref = mcpConnectionIdentity(f.registry.update(ref, { policy: { connect: 'ask', tools: 'ask', resources: 'deny' } }).config);
  f.registry.approveConnection(ref); await f.manager.reconnect('chat', ref);
  assert.deepEqual(f.manager.bindResources(scope(), ref, destination), []);
});

test('resource catalog refresh invalidates old bindings without changing their sealed source', async t => {
  const f = await lifecycleFixture(t); f.approve(); await f.manager.open('chat', f.ref);
  const binding = f.manager.bindResources(scope(), f.ref, destination)[0]!; const before = structuredClone(binding.origin);
  await f.manager.refresh('chat', 'generic');
  await assert.rejects(binding.execute({ uri: 'fixture://resource' }, context()), { code: 'DENIED' });
  assert.deepEqual(binding.origin, before); assert.equal(f.messages.flat().filter(m => 'method' in m && m.method === 'resources/read').length, 0);
});

test('resource HTTP credentials resolving after stop cannot send the old read', async t => {
  const http = await mcpHttpFixture(t, { bearer: 'fixture' }); const { registry } = registryMemory(t);
  const ref = mcpConnectionIdentity(registry.register(mcpConfig({ transport: { type: 'streamable-http', url: http.url,
    auth: { type: 'bearer', credentialRef: 'env:FIXTURE' } } })).config); registry.approveConnection(ref);
  let delayed = false, release: (() => void) | undefined;
  const manager = new McpConnectionManager(registry, { credentials: async () => {
    if (delayed) await new Promise<void>(resolve => { release = resolve; }); return 'fixture';
  } }); t.after(() => manager.dispose()); await manager.open('chat', ref);
  const controller = new AbortController(); const tool = manager.bindResources({ ...scope(), signal: controller.signal }, ref, destination)[0]!;
  delayed = true; const running = tool.execute({ uri: 'fixture://document' }, context());
  await waitUntil(() => !!release); controller.abort(); await assert.rejects(running); release!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(http.requests.filter(r => r.rpc === 'resources/read').length, 0);
});
