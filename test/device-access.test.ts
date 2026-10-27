import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deviceFixture } from './helpers/device-access.js';
import { readScopedFile } from '../src/files/scoped-read.js';
import { DeviceAccessSettings } from '../desktop/device-access-settings.js';
import { connection } from './helpers/server.js';
import { fileScopeCommand } from '../src/files/scope-command.js';

test('device policy grants new conversations without a picker and binds relative, tilde and other-root absolute paths', async t => {
  const f = await deviceFixture(t); assert.equal(f.service.fileScopes.roots(f.session.sessionId).length, 2);
  const second = f.service.createSession({ connectionId: 'fixture' }); assert.equal(f.service.fileScopes.roots(second.sessionId).length, 2);
  const { source } = f.start();
  for (const input of ['note.txt', '~/note.txt', join(f.outside, 'other.txt')]) {
    const binding = await f.service.fileScopes.bindRead(source, input);
    const result = await readScopedFile(f.service.fileScopes, binding, new AbortController().signal);
    assert.match(result.data.toString(), /text/); assert.equal(binding.mode, 'read');
  }
  assert.equal(f.service.fileScopes.overview(f.session.sessionId).device?.baseDirectory, f.home);
});
test('DSH canonical paths permit ordinary aliases but deny sensitive targets and sensitive display paths', async t => {
  const f = await deviceFixture(t); const { source } = f.start();
  await symlink(join(f.home, 'note.txt'), join(f.home, 'alias.txt'));
  assert.equal((await f.service.fileScopes.bindRead(source, 'alias.txt')).path, join(f.home, 'note.txt'));
  for (const name of ['.ssh', '.codex', '.aws', '.gnupg', 'Keychains']) { await mkdir(join(f.home, name)); await writeFile(join(f.home, name, 'secret'), 'excluded');
    await assert.rejects(f.service.fileScopes.bindRead(source, `${name}/secret`), { code: 'FILE_SCOPE_DENIED' }); }
  for (const name of ['.env', 'credentials.json', 'file-access.local.json']) { await writeFile(join(f.home, name), 'excluded');
    await assert.rejects(f.service.fileScopes.bindRead(source, name), { code: 'FILE_SCOPE_DENIED' }); }
  await symlink(join(f.home, '.ssh', 'secret'), join(f.home, 'public-alias'));
  await assert.rejects(f.service.fileScopes.bindRead(source, 'public-alias'), { code: 'FILE_SCOPE_DENIED' });
  await writeFile(join(f.outside, 'normal'), 'normal'); await symlink(join(f.outside, 'normal'), join(f.home, '.env.alias'));
  await assert.rejects(f.service.fileScopes.bindRead(source, '.env.alias'), { code: 'FILE_SCOPE_DENIED' });
});
test('disabling device access invalidates old read/write bindings and re-enabling creates a new authority epoch', async t => {
  const f = await deviceFixture(t); const { source } = f.start();
  const binding = await f.service.fileScopes.bindWrite(source, 'new.txt'); const before = f.service.fileScopes.snapshot(f.session.sessionId).policyVersion;
  f.set(false); assert.equal(f.service.fileScopes.roots(f.session.sessionId).length, 0);
  await assert.rejects(f.service.fileScopes.verify(binding), { code: 'FILE_SCOPE_DENIED' });
  f.set(true); assert.ok(f.service.fileScopes.snapshot(f.session.sessionId).policyVersion > before);
  await assert.rejects(f.service.fileScopes.verify(binding), { code: 'FILE_SCOPE_DENIED' });
  assert.notEqual((await f.service.fileScopes.bindWrite(source, 'new.txt')).grantId, binding.grantId);
});
test('remembered whole-device grants recover only with an enabled trusted host and matching destination', async t => {
  const f = await deviceFixture(t); const before = f.service.fileScopes.snapshot(f.session.sessionId);
  await f.service.dispose(); const restored = f.open(); assert.deepEqual(restored.fileScopes.snapshot(f.session.sessionId), before);
  const { source } = f.start(restored); await restored.fileScopes.bindRead(source, 'note.txt');
});
test('model service changes disable old device grants and cannot inherit another destination authority', async t => {
  const f = await deviceFixture(t); f.changeModel(); assert.equal(f.service.fileScopes.roots(f.session.sessionId).length, 0);
  assert.equal(f.service.fileScopes.overview(f.session.sessionId).device?.enabled, false);
  const { source } = f.start(); await assert.rejects(f.service.fileScopes.bindRead(source, 'note.txt'), { code: 'FILE_SCOPE_DENIED' });
});
test('v4 migration preserves existing data while rejecting undeclared device fields', async t => {
  const f = await deviceFixture(t); await f.service.dispose(); using db = new DatabaseSync(f.dbPath);
  db.exec('PRAGMA user_version = 4'); assert.throws(() => f.open(), { code: 'INVALID_DATA' });
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
  const row = db.prepare('SELECT record FROM sessions').get()!;
  const session = JSON.parse(String(row.record)); for (const grant of session.fileScope.grants) delete grant.device;
  db.prepare('UPDATE sessions SET record = ?').run(JSON.stringify(session)); const restored = f.open();
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9);
  assert.equal(restored.getSnapshot(f.session.sessionId).session.sessionId, f.session.sessionId);
});
test('host device preference is atomic, destination-bound and defaults off; renderer cannot supply filesystem roots', async t => {
  const f = await deviceFixture(t); const path = join(f.directory, 'file-access.local.json'); const config = connection('https://example.test');
  const settings = new DeviceAccessSettings(path); assert.equal(settings.enabled(config), false);
  settings.set(config, true); assert.equal(new DeviceAccessSettings(path).enabled(config), true);
  assert.equal(settings.enabled({ ...config, model: 'other-model' }), false);
  settings.set(config, false); assert.equal(JSON.parse(await readFile(path, 'utf8')).enabled, false);
  for (const extra of [{ roots: ['/'] }, { destination: 'fake' }, { enabled: 'yes' }]) {
    assert.throws(() => fileScopeCommand({ type: 'device', sessionId: 's', enabled: true, ...extra }), { code: 'FILE_SCOPE_INVALID' });
  }
});
test('corrupt or symlinked device preferences fail closed', async t => {
  const f = await deviceFixture(t); const path = join(f.directory, 'invalid.local.json'); await writeFile(path, '{}');
  assert.throws(() => new DeviceAccessSettings(path), { code: 'FILE_SCOPE_INVALID' });
  await symlink(path, join(f.directory, 'alias.local.json'));
  assert.throws(() => new DeviceAccessSettings(join(f.directory, 'alias.local.json')), { code: 'FILE_SCOPE_INVALID' });
});
