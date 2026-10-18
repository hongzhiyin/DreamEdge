import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpConnectionRegistry, SqliteMcpRegistryStore, mcpConnectionIdentity } from '../src/index.js';
import { add, context, registryDisk, registryMemory } from './helpers/mcp-registry.js';
import { mcpConfig } from './helpers/mcp.js';

test('edits own revisions, invalidate old approvals/pins and reject stale host commands', t => {
  const { registry } = registryMemory(t); const first = add(registry); registry.approveConnection(first);
  registry.pin('chat', first, { appId: 'com.example.alpha' });
  assert.equal(registry.resolve({ sessionId: 'chat', context: context() }).kind, 'selected');
  const changed = registry.update(first, { displayName: 'Changed' }); assert.equal(changed.config.configRevision, 2); assert.equal(changed.approval, undefined);
  assert.deepEqual(registry.resolve({ sessionId: 'chat', context: context() }), { kind: 'blocked', reason: 'stale-binding' });
  assert.throws(() => registry.approveConnection(first), { code: 'CONFLICT' });
  assert.throws(() => registry.update(mcpConnectionIdentity(changed.config), { serverId: 'other' }), { code: 'INVALID_REGISTRY' });
});

test('disable, revoke and explicit reapproval are distinct; enabling never grants permission', t => {
  const { registry } = registryMemory(t); const first = add(registry); registry.associate('alpha', { appId: 'com.example.alpha' });
  registry.approveConnection(first); const disabled = registry.setEnabled(first, false); assert.equal(disabled.approval, undefined);
  assert.throws(() => registry.approveConnection(mcpConnectionIdentity(disabled.config)), { code: 'DENIED' });
  const enabled = registry.setEnabled(mcpConnectionIdentity(disabled.config), true); const active = mcpConnectionIdentity(enabled.config);
  const selected = registry.resolve({ context: context() }); assert.ok(selected.kind === 'selected'); assert.equal(selected.candidate.connectionPermission, 'approval-required');
  const revoked = registry.revoke(active); assert.equal(revoked.revoked, true);
  assert.deepEqual(registry.resolve({ context: context({ source: 'user-selection', connectionRef: 'alpha' }) }), { kind: 'blocked', reason: 'revoked' });
  assert.throws(() => registry.approveConnection(active), { code: 'CONFLICT' });
  registry.approveConnection(mcpConnectionIdentity(revoked.config)); const approved = registry.resolve({ context: context() });
  assert.ok(approved.kind === 'selected'); assert.equal(approved.candidate.connectionPermission, 'approved');
  assert.equal(registry.snapshot().servers[0]?.config.policy.tools, 'ask');
});

test('policy denial cannot be overridden by connection approval', t => {
  const { registry } = registryMemory(t); const first = add(registry);
  const denied = registry.update(first, { policy: { connect: 'deny', tools: 'ask', resources: 'ask' } });
  assert.throws(() => registry.approveConnection(mcpConnectionIdentity(denied.config)), { code: 'DENIED' });
  assert.deepEqual(registry.resolve({ context: context({ source: 'user-selection', connectionRef: 'alpha' }) }), { kind: 'blocked', reason: 'denied' });
});

test('batch registration is atomic and snapshots cannot mutate stored values', t => {
  const { registry } = registryMemory(t); add(registry); const before = registry.snapshot();
  assert.throws(() => registry.registerMany([mcpConfig({ serverId: 'beta' }), mcpConfig({ serverId: 'alpha' })]), { code: 'DUPLICATE' });
  assert.deepEqual(registry.snapshot(), before);
  assert.throws(() => registry.snapshot().servers.push({ config: mcpConfig() as never, revoked: false }), TypeError);
  registry.registerMany([mcpConfig({ serverId: 'beta' }), mcpConfig({ serverId: 'gamma' })]);
  assert.equal(registry.snapshot().servers.length, 3);
});

test('registry, connection approval, associations and session selection survive restart', async t => {
  const f = await registryDisk(t); const ref = add(f.registry); f.registry.associate('alpha', { appId: 'com.example.alpha', profileRef: 'profile-a' });
  f.registry.approveConnection(ref); f.registry.pin('chat', ref, { appId: 'com.example.alpha', profileRef: 'profile-a' });
  const before = f.registry.snapshot(); f.store.close();
  const next = new SqliteMcpRegistryStore(f.path); t.after(() => next.close()); const restored = new McpConnectionRegistry(next, () => 1000);
  assert.deepEqual(restored.snapshot(), before);
  const result = restored.resolve({ sessionId: 'chat', context: context({ profileRef: 'profile-a' }) });
  assert.ok(result.kind === 'selected'); assert.equal(result.candidate.connectionPermission, 'approved');
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
});

test('failed save leaves no registration or approval change and can be retried explicitly', async t => {
  const f = await registryDisk(t); const ref = add(f.registry); const before = f.registry.snapshot(); const faults = new DatabaseSync(f.path); t.after(() => faults.close());
  faults.exec("CREATE TRIGGER fail_save BEFORE UPDATE ON mcp_registry BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  assert.throws(() => f.registry.approveConnection(ref), { code: 'STORE_FAILED' }); assert.deepEqual(f.registry.snapshot(), before);
  faults.exec('DROP TRIGGER fail_save');
  faults.exec('CREATE TRIGGER ignore_save BEFORE UPDATE ON mcp_registry BEGIN SELECT RAISE(IGNORE); END');
  assert.throws(() => f.registry.approveConnection(ref), { code: 'STORE_FAILED' }); assert.deepEqual(f.registry.snapshot(), before);
  faults.exec('DROP TRIGGER ignore_save'); f.registry.approveConnection(ref); assert.ok(f.registry.snapshot().servers[0]?.approval);
});

test('another writer cannot overwrite a newer registry revision', async t => {
  const f = await registryDisk(t); const other = new SqliteMcpRegistryStore(f.path); t.after(() => other.close());
  const stale = structuredClone(other.load()); add(f.registry); stale.revision++;
  assert.throws(() => other.save(stale, 0), { code: 'CONFLICT' }); assert.equal(other.load().servers.length, 1);
});

test('corrupted approval identity and unknown schema refuse to load without clearing data', async t => {
  const f = await registryDisk(t); const ref = add(f.registry); f.registry.approveConnection(ref); const faults = new DatabaseSync(f.path); t.after(() => faults.close());
  const broken = structuredClone(f.registry.snapshot()); broken.servers[0]!.approval!.identity = { ...ref, configDigest: '0'.repeat(64) };
  faults.prepare('UPDATE mcp_registry SET record=?').run(JSON.stringify(broken));
  assert.throws(() => new SqliteMcpRegistryStore(f.path), { code: 'INVALID_REGISTRY' });
  assert.equal(faults.prepare('SELECT record FROM mcp_registry').get()?.record, JSON.stringify(broken));
  faults.exec('PRAGMA user_version=99'); assert.throws(() => new SqliteMcpRegistryStore(f.path), { code: 'INVALID_REGISTRY' });
});

test('foreign databases and symbolic link targets are not initialized or replaced', async t => {
  const f = await registryDisk(t); const foreign = join(f.dir, 'foreign.sqlite'); const db = new DatabaseSync(foreign);
  db.exec('CREATE TABLE unrelated(value TEXT); PRAGMA user_version=1'); db.close(); const original = await readFile(foreign);
  assert.throws(() => new SqliteMcpRegistryStore(foreign), { code: 'INVALID_REGISTRY' }); assert.deepEqual(await readFile(foreign), original);
  const target = join(f.dir, 'target'); await writeFile(target, 'unchanged'); const link = join(f.dir, 'link'); await symlink(target, link);
  assert.throws(() => new SqliteMcpRegistryStore(link), { code: 'STORE_FAILED' }); assert.equal(await readFile(target, 'utf8'), 'unchanged');
});
