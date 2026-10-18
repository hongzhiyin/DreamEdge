import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseMcpServerConfig, mcpConnectionIdentity, McpConfigError, mcpClientOptions, piMcpVersion } from '../src/index.js';
import { mcpConfig } from './helpers/mcp.js';

test('generic stdio contracts preserve exact arguments, references and cross-platform paths without IO', () => {
  for (const command of ['/nonexistent/example service', 'C:\\Application Files\\service.exe']) {
    const config = parseMcpServerConfig(mcpConfig({ transport: { type: 'stdio', command, args: ['--name', '', 'two words', '$(no-shell)'], envRefs: { SERVICE_KEY: 'file:service' } } }));
    assert.equal(config.transport.type, 'stdio'); if (config.transport.type !== 'stdio') throw 0;
    assert.equal(config.transport.command, command); assert.deepEqual(config.transport.args, ['--name', '', 'two words', '$(no-shell)']);
    assert.deepEqual(config.transport.envRefs, { SERVICE_KEY: 'file:service' }); assert.equal(config.protocolVersion, '2025-11-25');
    assert.equal(config.requestTimeoutMs, 30000); assert.ok(Object.isFrozen(config.transport.args)); assert.ok(Object.isFrozen(config.policy));
    assert.deepEqual(mcpClientOptions(config).capabilities, {});
  }
});

test('HTTP authentication is a reference or OAuth profile, never a raw secret', () => {
  for (const auth of [{ type: 'none' }, { type: 'bearer', credentialRef: 'env:MCP_KEY' }, { type: 'oauth', profileId: 'workspace-1' }]) {
    const config = parseMcpServerConfig(mcpConfig({ transport: { type: 'streamable-http', url: 'https://EXAMPLE.test/mcp', auth } }));
    assert.equal(config.transport.type, 'streamable-http'); if (config.transport.type !== 'streamable-http') throw 0;
    assert.equal(config.transport.url, 'https://example.test/mcp'); assert.deepEqual(config.transport.auth, auth);
  }
  for (const url of ['http://127.0.0.1:4320/mcp', 'http://[::1]:4320/mcp']) {
    assert.equal(parseMcpServerConfig(mcpConfig({ transport: { type: 'streamable-http', url } })).transport.type, 'streamable-http');
  }
});

test('identity digest is stable across key order and invalidates on every configuration change', () => {
  const config = parseMcpServerConfig(mcpConfig()); const identity = mcpConnectionIdentity(config);
  assert.deepEqual(mcpConnectionIdentity(parseMcpServerConfig(JSON.parse(JSON.stringify(config)))), identity);
  assert.deepEqual(mcpConnectionIdentity(parseMcpServerConfig(Object.fromEntries(Object.entries(config).reverse()))), identity);
  const changes = [{ configRevision: 2 }, { enabled: false }, { policy: { connect: 'deny', tools: 'ask', resources: 'ask' } },
    { transport: { type: 'stdio', command: '/other/service' } }, { requestTimeoutMs: 100 }, { protocolVersion: '2025-06-18' }];
  for (const patch of changes) assert.notEqual(mcpConnectionIdentity(parseMcpServerConfig({ ...config, ...patch })).configDigest, identity.configDigest);
});

test('invalid configurations fail with stable redacted errors, including values that look like secrets', () => {
  const secret = 'fixture-secret-not-for-output';
  const transports: unknown[] = [
    { type: 'stdio', command: 'npx' }, { type: 'stdio', command: '/bin/test', cwd: '.' },
    { type: 'stdio', command: '/bin/test', env: { KEY: secret } }, { type: 'stdio', command: '/bin/test', inheritEnv: true },
    { type: 'stdio', command: '/bin/test', envRefs: { KEY: secret } }, { type: 'stdio', command: '/bin/test', args: [null] },
    { type: 'stdio', command: '/bin/test', url: 'https://example.test' },
    { type: 'streamable-http', url: 'http://example.test/mcp' }, { type: 'streamable-http', url: 'file:///tmp/x' },
    { type: 'streamable-http', url: `https://user:${secret}@example.test/mcp` },
    { type: 'streamable-http', url: `https://example.test/mcp?token=${secret}` },
    { type: 'streamable-http', url: 'https://example.test/mcp', auth: { type: 'bearer', token: secret } },
    { type: 'streamable-http', url: 'https://example.test/mcp', auth: { type: 'none', profileId: 'x' } },
    { type: 'streamable-http', url: 'https://example.test/mcp', auth: { type: 'oauth', profileId: 'x', credentialRef: 'env:X' } },
  ];
  const invalid = [...transports.map(transport => mcpConfig({ transport })), mcpConfig({ enabled: 'true' }),
    mcpConfig({ configRevision: 0 }), mcpConfig({ protocolVersion: '2099-01-01' }), mcpConfig({ requestTimeoutMs: Infinity }),
    mcpConfig({ policy: { connect: 'allow', tools: 'ask', resources: 'ask' } }), mcpConfig({ extra: secret }), mcpConfig({ policy: { connect: { toString: null, valueOf: null }, tools: 'ask', resources: 'ask' } })];
  for (const value of invalid) assert.throws(() => parseMcpServerConfig(value), error => {
    assert.ok(error instanceof McpConfigError); assert.equal(error.code, 'INVALID_MCP_CONFIG'); assert.ok(!error.message.includes(secret)); return true;
  });
});

test('parser rejects getters and cyclic values without invoking them or accepting runtime objects', () => {
  let touched = false; const value = { get transport() { touched = true; throw new Error('secret'); } };
  assert.throws(() => parseMcpServerConfig(value), McpConfigError); assert.equal(touched, false);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => parseMcpServerConfig(cyclic), McpConfigError);
  assert.throws(() => parseMcpServerConfig(new Date()), McpConfigError);
});

test('direct Pi dependency, lock integrity and bundled third-party license stay pinned', async () => {
  const example = parseMcpServerConfig(JSON.parse(await readFile('config/mcp.example.json', 'utf8'))); assert.equal(example.enabled, false);
  const metadata = JSON.parse(await readFile('package.json', 'utf8')); const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const installed = JSON.parse(await readFile('node_modules/@earendil-works/pi-mcp/package.json', 'utf8'));
  assert.equal(metadata.dependencies['@earendil-works/pi-mcp'], piMcpVersion); assert.equal(installed.version, piMcpVersion);
  assert.equal(lock.packages[''].dependencies['@earendil-works/pi-mcp'], piMcpVersion);
  assert.equal(lock.packages['node_modules/@earendil-works/pi-mcp'].version, piMcpVersion);
  assert.match(lock.packages['node_modules/@earendil-works/pi-mcp'].integrity, /^sha512-/);
  assert.equal(await readFile('licenses/Pi-MCP-1.1.0-MCP-SDK-NOTICE.txt', 'utf8'), await readFile('node_modules/@earendil-works/pi-mcp/LICENSES/modelcontextprotocol-typescript-sdk.txt', 'utf8'));
});
