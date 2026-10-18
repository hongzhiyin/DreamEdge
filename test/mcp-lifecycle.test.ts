import test from 'node:test';
import assert from 'node:assert/strict';
import { McpConnectionManager, mcpConnectionIdentity } from '../src/index.js';
import { catalogTool, lifecycleFixture } from './helpers/mcp-connection.js';
import { waitUntil } from './helpers/storage.js';

test('unapproved/disabled configs never create a transport; approved connection discovers metadata only', async t => {
  const f = await lifecycleFixture(t);
  await assert.rejects(f.manager.open('chat', f.ref), { code: 'APPROVAL_REQUIRED' }); assert.equal(f.servers.length, 0);
  f.approve(); const view = await f.manager.open('chat', f.ref);
  assert.equal(view.state, 'ready'); assert.equal(view.catalog?.tools[0]?.availability, 'compatible');
  assert.equal(view.catalog?.resources[0]?.uri, 'fixture://resource'); assert.equal(view.catalog?.resourceTemplates.length, 1);
  assert.equal(f.messages.flat().some(m => 'method' in m && ['tools/call', 'resources/read'].includes(m.method)), false);
  f.registry.setEnabled(f.ref, false); assert.equal(f.manager.snapshot('chat', 'generic')?.state, 'blocked');
  await assert.rejects(f.manager.reconnect('chat', f.ref), { code: 'CONFIG_CHANGED' });
});

test('one session reuses its generation, while other sessions use isolated clients', async t => {
  const f = await lifecycleFixture(t); f.approve();
  const [a, b] = await Promise.all([f.manager.open('a', f.ref), f.manager.open('a', f.ref)]);
  assert.equal(a.generation, b.generation); assert.equal(f.servers.length, 1);
  const c = await f.manager.open('b', f.ref); assert.notEqual(c.generation, a.generation); assert.equal(f.servers.length, 2);
  await f.manager.closeSession('a'); assert.equal(f.manager.snapshot('a', 'generic'), undefined); assert.equal(f.manager.snapshot('b', 'generic')?.state, 'ready');
});

test('notifications refresh the catalog without changing previous snapshots', async t => {
  const f = await lifecycleFixture(t); f.approve(); const original = await f.manager.open('chat', f.ref);
  f.setTools([catalogTool('changed')]); await f.servers[0]!.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  await waitUntil(() => f.manager.snapshot('chat', 'generic')?.catalog?.revision === 2);
  const next = f.manager.snapshot('chat', 'generic')!; assert.notEqual(next.catalog?.digest, original.catalog?.digest);
  assert.equal(original.catalog?.tools[0]?.definition.name, 'operation'); assert.equal(next.catalog?.tools[0]?.definition.name, 'changed');
  assert.throws(() => { next.catalog!.tools.length = 0; }, TypeError);
});

test('schema compatibility and denied metadata remain explicit', async t => {
  const f = await lifecycleFixture(t); f.setTools([{ ...catalogTool(), inputSchema: { type: 'object' } }]); f.approve();
  assert.equal((await f.manager.open('chat', f.ref)).catalog?.tools[0]?.availability, 'unsupported-schema');
  const config = f.registry.update(f.ref, { policy: { connect: 'ask', tools: 'deny', resources: 'deny' } }).config;
  const ref = mcpConnectionIdentity(config); f.registry.approveConnection(ref);
  const next = await f.manager.reconnect('chat', ref); assert.equal(next.catalog?.tools[0]?.availability, 'denied');
  assert.equal(next.catalog?.resourceDiscovery, 'denied');
  assert.equal(f.messages.at(-1)!.some(m => 'method' in m && m.method === 'resources/list'), false);
});

test('explicit disconnect stops discovery; only explicit reconnect creates another generation', async t => {
  const f = await lifecycleFixture(t); f.approve(); const first = await f.manager.open('chat', f.ref);
  await f.manager.disconnect('chat', 'generic'); assert.equal((await f.manager.open('chat', f.ref)).state, 'closed'); assert.equal(f.servers.length, 1);
  const next = await f.manager.reconnect('chat', f.ref); assert.equal(next.state, 'ready'); assert.notEqual(next.generation, first.generation);
  await f.manager.dispose(); await assert.rejects(f.manager.open('chat', f.ref), { code: 'CLOSED' });
});

test('transport drop is disconnected and never replays an operation', async t => {
  const f = await lifecycleFixture(t); f.approve(); await f.manager.open('chat', f.ref); await f.servers[0]!.close();
  assert.equal(f.manager.snapshot('chat', 'generic')?.state, 'disconnected'); assert.equal((await f.manager.open('chat', f.ref)).state, 'disconnected');
  assert.equal(f.servers.length, 1); assert.equal((await f.manager.reconnect('chat', f.ref)).state, 'ready');
});

test('revoke during slow catalog discovery closes the connection and discards late metadata', async t => {
  const f = await lifecycleFixture(t); let reply: ((result: unknown) => Promise<void>) | undefined;
  f.handle((request, send) => { if (request.method === 'tools/list') reply = send; else void send(request.method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] }); });
  f.approve(); const opening = f.manager.open('chat', f.ref); await waitUntil(() => Boolean(reply)); f.registry.revoke(f.ref);
  const view = await opening; assert.equal(view.state, 'blocked'); assert.equal(view.catalog, undefined);
  await reply!({ tools: [catalogTool()] }).catch(() => {}); assert.equal(f.manager.snapshot('chat', 'generic')?.state, 'blocked');
});

test('catalog duplicates, aggregate counts and unsupported protocols fail without leaking raw errors', async t => {
  const f = await lifecycleFixture(t); f.approve(); f.setTools([catalogTool(), catalogTool()]);
  const duplicate = await f.manager.open('chat', f.ref); assert.equal(duplicate.error?.code, 'INVALID_CATALOG');
  f.setTools(Array.from({ length: 257 }, (_, n) => catalogTool(`tool_${n}`)));
  assert.equal((await f.manager.reconnect('chat', f.ref)).error?.code, 'LIMIT_EXCEEDED');
  f.setVersion('2099-secret-version'); const invalid = await f.manager.reconnect('chat', f.ref);
  assert.equal(invalid.state, 'failed'); assert.ok(!JSON.stringify(invalid).includes('secret-version'));
});

test('catalog timeout and host factory failures publish sanitized states', async t => {
  const f = await lifecycleFixture(t, { startupTimeoutMs: 30 }); f.approve(); f.handle(() => {});
  assert.equal((await f.manager.open('chat', f.ref)).error?.code, 'TIMEOUT');
  f.setFactoryFailure(new Error('credential-should-not-be-visible'));
  const view = await f.manager.reconnect('chat', f.ref); assert.equal(view.state, 'failed'); assert.ok(!JSON.stringify(view).includes('credential-should'));
});

test('closing while an injected factory is pending cleans up its late transport without initializing', async t => {
  const f = await lifecycleFixture(t); f.approve(); let complete!: (transport: import('@earendil-works/pi-mcp').McpTransport) => void;
  const manager = new McpConnectionManager(f.registry, { transportFactory: () => new Promise(resolve => { complete = resolve; }) });
  t.after(() => manager.dispose()); const opening = manager.open('chat', f.ref); await waitUntil(() => Boolean(complete));
  await manager.disconnect('chat', 'generic'); assert.equal((await opening).state, 'closed');
  const { createInMemoryTransportPair } = await import('@earendil-works/pi-mcp/testing'); const pair = createInMemoryTransportPair();
  let closed = false; pair.server.onClose(() => { closed = true; }); complete(pair.client); await waitUntil(() => closed);
});

test('dispose also waits for the replaced generation that is still shutting down', async t => {
  const f = await lifecycleFixture(t); f.approve();
  const { createInMemoryTransportPair } = await import('@earendil-works/pi-mcp/testing'); const pair = createInMemoryTransportPair();
  await pair.server.start(); pair.server.onMessage(message => {
    if ('id' in message && 'method' in message) void pair.server.send({ jsonrpc: '2.0', id: message.id,
      result: { protocolVersion: '2025-11-25', serverInfo: { name: 'fixture', version: '1' }, capabilities: {} } });
  });
  const close = pair.client.close.bind(pair.client); let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }); pair.client.close = async () => { await waiting; await close(); };
  let factories = 0; const manager = new McpConnectionManager(f.registry, { transportFactory: async () => { factories++; return pair.client; } });
  t.after(async () => { release(); await manager.dispose(); });
  assert.equal((await manager.open('chat', f.ref)).state, 'ready'); const reconnect = manager.reconnect('chat', f.ref);
  let disposed = false; const disposal = manager.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(disposed, false);
  release(); await disposal; await reconnect; assert.equal(factories, 1);
});

test('pagination budgets stop before an unbounded catalog can be assembled', async t => {
  const f = await lifecycleFixture(t); f.approve(); let page = 0;
  f.handle((request, reply) => {
    if (request.method === 'tools/list') return reply({ tools: Array.from({ length: 100 }, (_, n) => catalogTool(`item_${page}_${n}`)), nextCursor: String(++page) });
    return reply(request.method === 'resources/list' ? { resources: [] } : { resourceTemplates: [] });
  });
  const result = await f.manager.open('chat', f.ref); assert.equal(result.error?.code, 'LIMIT_EXCEEDED'); assert.equal(page, 3);
});
