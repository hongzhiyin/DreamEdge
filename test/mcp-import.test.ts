import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPiMcpConfig } from '../src/index.js';
import { registryMemory, add } from './helpers/mcp-registry.js';

test('Pi mcpServers previews map declared transports and references without resolving credentials', () => {
  const result = previewPiMcpConfig({ mcpServers: {
    local: { command: '/configured/generic-service', args: ['mcp'], env: { KEY: '${SERVICE_KEY}' }, timeout: 2, enabled: false },
    remote: { type: 'http', url: 'https://service.example/mcp', headers: { Authorization: 'Bearer ${SERVICE_TOKEN}' } },
  } });
  assert.deepEqual(result.diagnostics, []); assert.equal(result.configs.length, 2); const [local, remote] = result.configs;
  assert.equal(local!.enabled, false); assert.equal(local!.requestTimeoutMs, 2000);
  assert.ok(local!.transport.type === 'stdio'); assert.deepEqual(local!.transport.envRefs, { KEY: 'env:SERVICE_KEY' });
  assert.ok(remote!.transport.type === 'streamable-http'); assert.deepEqual(remote!.transport.auth, { type: 'bearer', credentialRef: 'env:SERVICE_TOKEN' });
  assert.equal(remote!.policy.connect, 'ask');
});

test('unsafe expansions, plaintext headers and unsupported Pi features produce redacted diagnostics', () => {
  const secret = 'secret-do-not-echo';
  for (const entry of [
    { command: '/configured/server', env: { KEY: '!touch /tmp/should-not-run' } },
    { command: '/configured/server', env: { KEY: secret } },
    { url: 'https://example.test/mcp', headers: { Authorization: `Bearer ${secret}` } },
    { command: '/configured/server', exposure: 'codemode' },
    { command: 'npx', args: ['-y', 'uninstalled-package'] },
    { command: '/configured/server', enabled: null },
    { url: 'https://example.test/mcp', command: '/configured/server' },
    { url: 'https://example.test/mcp', oauth: { clientSecret: secret } },
  ]) {
    const preview = previewPiMcpConfig({ mcpServers: { fixture: entry } }); assert.equal(preview.configs.length, 0); assert.equal(preview.diagnostics.length, 1);
    assert.ok(!JSON.stringify(preview).includes(secret)); assert.ok(!JSON.stringify(preview).includes('touch'));
  }
});

test('preview can report entry failures without registering anything; selected registration is atomic', t => {
  const { registry } = registryMemory(t); add(registry, 'existing'); const before = registry.snapshot();
  const result = previewPiMcpConfig({ mcpServers: { good: { command: '/configured/service' }, invalid: { command: 'relative' } } });
  assert.equal(result.configs.length, 1); assert.equal(result.diagnostics.length, 1); assert.deepEqual(registry.snapshot(), before);
  registry.registerMany(result.configs); assert.equal(registry.snapshot().servers.length, 2); assert.equal(registry.snapshot().servers[1]?.approval, undefined);
  assert.throws(() => registry.registerMany(result.configs), { code: 'DUPLICATE' });
});

test('malformed top-level input and accessors are refused without invoking code', () => {
  let invoked = false;
  const preview = previewPiMcpConfig({ get mcpServers() { invoked = true; throw 0; } });
  assert.equal(invoked, false); assert.equal(preview.diagnostics[0]?.index, -1);
  for (const value of [null, [], { mcpServers: [] }, { mcpServers: {}, autoEnableCodemode: true }]) assert.equal(previewPiMcpConfig(value).diagnostics.length, 1);
});
