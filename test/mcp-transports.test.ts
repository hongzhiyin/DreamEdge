import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { McpOAuthProvider, MemoryOAuthStateStore } from '@earendil-works/pi-mcp/oauth';
import { McpConnectionManager, mcpConnectionIdentity } from '../src/index.js';
import type { McpConnectionOptions } from '../src/index.js';
import { registryMemory } from './helpers/mcp-registry.js';
import { mcpConfig } from './helpers/mcp.js';
import { mcpHttpFixture } from './helpers/mcp-http.js';
import { waitUntil } from './helpers/storage.js';
function setup(t: Parameters<typeof registryMemory>[0], transport: unknown, options: McpConnectionOptions = {}) {
  const { registry } = registryMemory(t); const ref = mcpConnectionIdentity(registry.register(mcpConfig({ serverId: 'service', transport, requestTimeoutMs: 1500 })).config);
  const manager = new McpConnectionManager(registry, options); t.after(() => manager.dispose());
  return { manager, registry, ref, approve: () => registry.approveConnection(ref) };
}
const stdio = (mode?: string) => ({ type: 'stdio', command: process.execPath,
  args: [resolve('dist/test/fixtures/mcp-service.js'), ...(mode ? [mode] : [])], envRefs: { MCP_TEST_TOKEN: 'env:MCP_FIXTURE' } });

test('real Pi stdio connects with explicit credentials without inheriting host secrets', async t => {
  const old = process.env.DREAMEDGE_TEST_PRIVATE; process.env.DREAMEDGE_TEST_PRIVATE = 'host-private';
  t.after(() => { if (old === undefined) delete process.env.DREAMEDGE_TEST_PRIVATE; else process.env.DREAMEDGE_TEST_PRIVATE = old; });
  let resolutions = 0; const f = setup(t, stdio(), { credentials: async () => { resolutions++; return 'fixture-token'; } });
  await assert.rejects(f.manager.open('chat', f.ref), { code: 'APPROVAL_REQUIRED' }); assert.equal(resolutions, 0);
  f.approve(); const view = await f.manager.open('chat', f.ref); assert.equal(view.state, 'ready');
  assert.equal(view.catalog?.instructions, 'provided=true; inherited=false'); assert.equal(view.catalog?.tools.length, 1);
  await f.manager.disconnect('chat', 'service'); assert.equal(f.manager.snapshot('chat', 'service')?.state, 'closed');
  const directory = await mkdtemp(join(tmpdir(), 'mcp-path-test-')), command = join(directory, 'runner');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(command, '#!/usr/bin/env node\n' + await readFile(resolve('dist/test/fixtures/mcp-service.js'), 'utf8'), { mode: 0o700 });
  const indirect = setup(t, { type: 'stdio', command, args: [], envRefs: {} }); indirect.approve();
  assert.equal((await indirect.manager.open('chat', indirect.ref)).state, 'ready');
});

test('stdio exit and missing executable are sanitized and do not auto-start again', async t => {
  const f = setup(t, stdio('exit'), { credentials: async () => 'fixture-token' }); f.approve(); await f.manager.open('chat', f.ref);
  await waitUntil(() => f.manager.snapshot('chat', 'service')?.state === 'disconnected');
  assert.equal((await f.manager.open('chat', f.ref)).state, 'disconnected');
  const config = f.registry.update(f.ref, { transport: { type: 'stdio', command: '/missing-secret-path/executable' } }).config;
  const ref = mcpConnectionIdentity(config); f.registry.approveConnection(ref); const failed = await f.manager.reconnect('chat', ref);
  assert.equal(failed.state, 'failed'); assert.ok(!JSON.stringify(failed).includes('missing-secret-path'));
});

test('stdio timeout closes the process and never exports captured stderr', async t => {
  const f = setup(t, stdio('stall'), { credentials: async () => 'fixture-token', startupTimeoutMs: 100 }); f.approve();
  const view = await f.manager.open('chat', f.ref); assert.equal(view.error?.code, 'TIMEOUT'); assert.ok(!JSON.stringify(view).includes('fixture-secret'));
});

test('HTTP metadata discovery uses bearer auth and closes the protocol session on disconnect', async t => {
  const server = await mcpHttpFixture(t, { bearer: 'fixture-token' });
  const f = setup(t, { type: 'streamable-http', url: server.url, auth: { type: 'bearer', credentialRef: 'file:mcp' } }, { credentials: async () => 'fixture-token' });
  f.approve(); const view = await f.manager.open('chat', f.ref); assert.equal(view.state, 'ready'); assert.ok(!JSON.stringify(view).includes('fixture-token'));
  assert.ok(server.requests.every(r => r.authorization === 'Bearer fixture-token')); assert.equal(server.requests.filter(r => r.rpc === 'initialize').length, 1);
  await f.manager.disconnect('chat', 'service'); assert.ok(server.requests.some(r => r.method === 'DELETE'));
});

test('authentication required does not loop; explicit credential update and reconnect can recover', async t => {
  const server = await mcpHttpFixture(t, { bearer: 'correct' }); let token = 'wrong';
  const f = setup(t, { type: 'streamable-http', url: server.url, auth: { type: 'bearer', credentialRef: 'env:MCP_TEST' } }, { credentials: async () => token }); f.approve();
  const failed = await f.manager.open('chat', f.ref); assert.equal(failed.state, 'auth-required'); assert.ok(!JSON.stringify(failed).includes('fixture-token'));
  const count = server.requests.length; assert.equal((await f.manager.open('chat', f.ref)).state, 'auth-required'); assert.equal(server.requests.length, count);
  token = 'correct'; assert.equal((await f.manager.reconnect('chat', f.ref)).state, 'ready');
});

test('Pi OAuth provider with stored tokens is reusable; missing profile remains auth-required', async t => {
  const server = await mcpHttpFixture(t, { bearer: 'oauth-fixture' }); const store = new MemoryOAuthStateStore();
  store.save({ serverUrl: server.url, tokens: { access_token: 'oauth-fixture', token_type: 'Bearer' } });
  const provider = new McpOAuthProvider({ serverUrl: server.url, redirectUrl: 'http://127.0.0.1:9999/callback', store,
    clientMetadata: { client_name: 'fixture' }, onRedirect: () => { throw new Error('No interactive login in fixture'); } });
  let available = false;
  const f = setup(t, { type: 'streamable-http', url: server.url, auth: { type: 'oauth', profileId: 'profile' } },
    { oauthProfile: async () => available ? { provider, allowedOrigins: [] } : undefined }); f.approve();
  assert.equal((await f.manager.open('chat', f.ref)).state, 'auth-required'); assert.equal(server.requests.length, 0);
  available = true; assert.equal((await f.manager.reconnect('chat', f.ref)).state, 'ready');
});

test('HTTP stream notification refreshes metadata and Pi resumes the stream without a second initialize', async t => {
  const server = await mcpHttpFixture(t, { streams: true }); const f = setup(t, { type: 'streamable-http', url: server.url }); f.approve();
  const original = await f.manager.open('chat', f.ref); assert.equal(original.state, 'ready'); await waitUntil(() => server.streams.size > 0);
  server.state.toolName = 'second'; const eventId = server.notify();
  await waitUntil(() => f.manager.snapshot('chat', 'service')?.catalog?.revision === 2);
  server.drop(); await waitUntil(() => server.requests.filter(r => r.method === 'GET').length >= 2);
  assert.equal(server.requests.filter(r => r.method === 'GET').at(-1)?.lastEventId, eventId);
  assert.equal(server.requests.filter(r => r.rpc === 'initialize').length, 1);
  await f.manager.disconnect('chat', 'service'); assert.equal(f.manager.snapshot('chat', 'service')?.state, 'closed');
});

test('expired HTTP session requires explicit reconstruction and does not reuse stale catalog', async t => {
  const server = await mcpHttpFixture(t); const f = setup(t, { type: 'streamable-http', url: server.url }); f.approve();
  const first = await f.manager.open('chat', f.ref); server.state.expired = true;
  assert.equal((await f.manager.refresh('chat', 'service')).state, 'disconnected'); assert.equal(f.manager.snapshot('chat', 'service')?.catalog, undefined);
  server.state.expired = false; const second = await f.manager.reconnect('chat', f.ref); assert.equal(second.state, 'ready'); assert.notEqual(second.generation, first.generation);
});

test('redirects never forward credentials and oversized JSON catalogs are rejected', async t => {
  const target = await mcpHttpFixture(t); const source = await mcpHttpFixture(t); source.state.redirect = target.url;
  const f = setup(t, { type: 'streamable-http', url: source.url, auth: { type: 'bearer', credentialRef: 'env:TEST' } }, { credentials: async () => 'fixture-token' }); f.approve();
  assert.equal((await f.manager.open('chat', f.ref)).error?.code, 'TARGET_DENIED'); assert.equal(target.requests.length, 0);
  source.state.redirect = ''; source.state.oversized = true;
  assert.equal((await f.manager.reconnect('chat', f.ref)).error?.code, 'LIMIT_EXCEEDED');
});
