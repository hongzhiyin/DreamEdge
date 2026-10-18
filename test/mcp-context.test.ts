import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpConnectionIdentity, parseMcpAppContext } from '../src/index.js';
import { add, context, registryMemory } from './helpers/mcp-registry.js';

test('generic app and profile mappings resolve independently with no endpoint guessing', t => {
  const { registry } = registryMemory(t); add(registry, 'service-a'); add(registry, 'service-b');
  registry.associate('service-a', { appId: 'com.example.alpha', profileRef: 'work' });
  registry.associate('service-b', { appId: 'com.example.beta' });
  const a = registry.resolve({ context: context({ profileRef: 'work', windowRef: 'window-1', resourceRef: 'opaque://object' }) });
  assert.ok(a.kind === 'selected'); assert.equal(a.candidate.identity.serverId, 'service-a'); assert.equal(a.context?.resourceRef, 'opaque://object');
  const b = registry.resolve({ context: context({ appId: 'com.example.beta' }) }); assert.ok(b.kind === 'selected'); assert.equal(b.candidate.identity.serverId, 'service-b');
  assert.deepEqual(registry.resolve({ context: context({ appId: 'com.example.unregistered' }) }), { kind: 'unmatched' });
  assert.deepEqual(registry.resolve({ context: context() }), { kind: 'blocked', reason: 'context-required' });
  assert.deepEqual(registry.resolve({ context: context({ profileRef: 'personal' }) }), { kind: 'unmatched' });
});

test('multiple candidates require selection regardless of registration order', t => {
  const { registry } = registryMemory(t); add(registry, 'zeta'); add(registry, 'alpha');
  for (const serverId of ['zeta', 'alpha']) registry.associate(serverId, { appId: 'com.example.alpha' });
  const result = registry.resolve({ context: context() }); assert.ok(result.kind === 'choice');
  assert.deepEqual(result.candidates.map(c => c.identity.serverId), ['alpha', 'zeta']);
});

test('explicit user selection beats mapping but provider references must match a registered association', t => {
  const { registry } = registryMemory(t); add(registry, 'alpha'); add(registry, 'beta'); registry.associate('alpha', { appId: 'com.example.alpha' });
  const direct = registry.resolve({ context: context({ source: 'user-selection', connectionRef: 'beta' }) }); assert.ok(direct.kind === 'selected'); assert.equal(direct.via, 'reference');
  assert.deepEqual(registry.resolve({ context: context({ source: 'provider', connectionRef: 'beta' }) }), { kind: 'blocked', reason: 'unassociated-reference' });
  assert.deepEqual(registry.resolve({ context: context({ connectionRef: 'unknown' }) }), { kind: 'blocked', reason: 'missing-server' });
  const registered = registry.resolve({ context: context({ connectionRef: 'alpha' }) }); assert.ok(registered.kind === 'selected');
});

test('session selection is version bound and cannot silently retarget after context changes', t => {
  const { registry } = registryMemory(t); const alpha = add(registry, 'alpha'); add(registry, 'beta');
  registry.associate('beta', { appId: 'com.example.alpha' }); registry.pin('chat', alpha, { appId: 'com.example.alpha', profileRef: 'p' });
  const pinned = registry.resolve({ sessionId: 'chat', context: context({ profileRef: 'p', connectionRef: 'beta' }) });
  assert.ok(pinned.kind === 'selected'); assert.equal(pinned.candidate.identity.serverId, 'alpha'); assert.equal(pinned.via, 'session');
  assert.deepEqual(registry.resolve({ sessionId: 'chat', context: context({ appId: 'com.example.ai-host', profileRef: 'p' }) }), { kind: 'blocked', reason: 'context-changed' });
  registry.update(alpha, { displayName: 'New name' });
  assert.deepEqual(registry.resolve({ sessionId: 'chat', context: context({ profileRef: 'p' }) }), { kind: 'blocked', reason: 'stale-binding' });
  registry.unpin('chat'); const next = registry.resolve({ context: context({ profileRef: 'p' }) }); assert.ok(next.kind === 'selected'); assert.equal(next.candidate.identity.serverId, 'beta');
});

test('missing, stale, future or untrusted task context cannot choose a connection', t => {
  const { registry } = registryMemory(t); add(registry); registry.associate('alpha', { appId: 'com.example.alpha' });
  assert.deepEqual(registry.resolve({}), { kind: 'blocked', reason: 'context-required' });
  for (const capturedAt of [0, 1001]) assert.deepEqual(registry.resolve({ context: context({ capturedAt }), maxAgeMs: 100 }), { kind: 'blocked', reason: 'stale-context' });
  assert.deepEqual(registry.resolve({ context: context({ source: 'untrusted', connectionRef: 'alpha' }) }), { kind: 'blocked', reason: 'untrusted-context' });
  assert.throws(() => parseMcpAppContext(context({ title: 'Some application' })), { code: 'INVALID_REGISTRY' });
  assert.throws(() => parseMcpAppContext(context({ appId: ' ' })), { code: 'INVALID_REGISTRY' });
});

test('service-only session selection cannot absorb arbitrary foreground context', t => {
  const { registry } = registryMemory(t); registry.pin('chat', add(registry));
  assert.equal(registry.resolve({ sessionId: 'chat' }).kind, 'selected');
  assert.deepEqual(registry.resolve({ sessionId: 'chat', context: context() }), { kind: 'blocked', reason: 'context-changed' });
});

test('disabled or revoked explicit choices do not fall back to another service', t => {
  const { registry } = registryMemory(t); const a = add(registry, 'alpha'); add(registry, 'beta');
  for (const serverId of ['alpha', 'beta']) registry.associate(serverId, { appId: 'com.example.alpha' });
  const off = registry.setEnabled(a, false);
  assert.deepEqual(registry.resolve({ context: context({ connectionRef: 'alpha' }) }), { kind: 'blocked', reason: 'disabled' });
  registry.revoke(mcpConnectionIdentity(off.config));
  assert.deepEqual(registry.resolve({ context: context({ connectionRef: 'alpha' }) }), { kind: 'blocked', reason: 'revoked' });
  const active = registry.resolve({ context: context() }); assert.ok(active.kind === 'selected'); assert.equal(active.candidate.identity.serverId, 'beta');
});

test('association deduplication and removal are explicit; selected snapshots remain immutable', t => {
  const { registry } = registryMemory(t); add(registry); const rule = { appId: 'com.example.alpha' };
  registry.associate('alpha', rule); registry.associate('alpha', rule); assert.equal(registry.snapshot().associations.length, 1);
  const selected = registry.resolve({ context: context() }); assert.ok(selected.kind === 'selected');
  assert.throws(() => { selected.candidate.displayName = 'tampered'; }, TypeError);
  registry.dissociate('alpha', rule); assert.deepEqual(registry.resolve({ context: context() }), { kind: 'unmatched' });
});
