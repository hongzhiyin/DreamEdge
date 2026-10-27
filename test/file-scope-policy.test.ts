import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, mkdir, symlink, link, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { scopeFixture } from './helpers/file-scopes.js';

test('trusted selector creates session-specific immutable snapshots; cancellation creates no grant', async t => {
  const f = await scopeFixture(t); f.select(undefined);
  assert.equal(await f.choose(), undefined); assert.equal(f.service.fileScopes.snapshot(f.session.sessionId).grants.length, 0);
  await mkdir(join(f.root, '.ssh')); f.select(join(f.root, '.ssh'));
  await assert.rejects(f.choose(), { code: 'FILE_SCOPE_DENIED' });
  f.select(join(f.root, '.SSH')); await assert.rejects(f.choose());
  f.select(f.root); const grant = (await f.choose())!;
  const copy = f.service.fileScopes.snapshot(f.session.sessionId); copy.grants[0]!.mode = 'read-write';
  assert.equal(f.service.fileScopes.snapshot(f.session.sessionId).grants[0]!.mode, 'read');
  const other = f.service.createSession({ connectionId: f.session.connectionId });
  const { source } = f.start();
  await assert.rejects(f.service.fileScopes.bind({ ...source, sessionId: other.sessionId }, grant.grantId, 'input.txt', 'read'));
});
test('read grant cannot authorize writes; traversal, prefix siblings, secrets and exclusions are rejected', async t => {
  const f = await scopeFixture(t); const grant = (await f.choose({ mode: 'read', remember: false, excludes: ['private'] }))!;
  await mkdir(join(f.root, 'private')); await writeFile(join(f.root, 'private', 'a'), 'excluded');
  await writeFile(join(f.root, '.env'), 'secret'); await writeFile(join(f.root, '.ENV'), 'secret'); await writeFile(join(f.root, 'credentials.local.json'), 'secret');
  const { source } = f.start();
  for (const path of ['../outside/secret.txt', join(f.directory, 'root-other/a'), '.env', '.ENV', 'credentials.local.json', 'private/a', '~/.ssh/id_rsa']) {
    await assert.rejects(f.service.fileScopes.bind(source, grant.grantId, path, 'read'));
  }
  await assert.rejects(f.service.fileScopes.bind(source, grant.grantId, 'new.txt', 'write'));
  const binding = await f.service.fileScopes.bind(source, grant.grantId, 'input.txt', 'read'); assert.equal(binding.root, f.root);
  assert.equal(Object.isFrozen(binding), true);
});
test('links, linked directories and hard-linked files never receive an IO binding', async t => {
  const f = await scopeFixture(t); const grant = (await f.choose())!; const { source } = f.start();
  await symlink(f.outside, join(f.root, 'linked')); await symlink(join(f.outside, 'secret.txt'), join(f.root, 'link'));
  await link(join(f.outside, 'secret.txt'), join(f.root, 'hard'));
  for (const path of ['linked/secret.txt', 'link', 'hard']) await assert.rejects(f.service.fileScopes.bind(source, grant.grantId, path, 'read'));
});
test('revocation and any policy revision invalidate existing bindings during an active run', async t => {
  const f = await scopeFixture(t); const grant = (await f.choose())!; const { source } = f.start();
  const binding = await f.service.fileScopes.bind(source, grant.grantId, 'input.txt', 'read');
  await f.choose(); await assert.rejects(f.service.fileScopes.verify(binding), { code: 'FILE_SCOPE_STALE' });
  f.service.fileScopes.revoke(f.session.sessionId, grant.grantId);
  await assert.rejects(f.service.fileScopes.bind(source, grant.grantId, 'input.txt', 'read'));
});
test('expired grants and destination changes fail closed', async t => {
  const f = await scopeFixture(t); const grant = (await f.choose({ mode: 'read', remember: true, expiresAt: Date.now() + 2000 }))!;
  const { source } = f.start(); const binding = await f.service.fileScopes.bind(source, grant.grantId, 'input.txt', 'read');
  f.changeModel(); await assert.rejects(f.service.fileScopes.verify(binding), { code: 'FILE_SCOPE_DENIED' });
  f.advance(3000); await assert.rejects(f.service.fileScopes.verify(binding), { code: 'FILE_SCOPE_DENIED' });
});
test('root replacement and path substitution after binding are rejected at actual IO gate', async t => {
  const f = await scopeFixture(t); const grant = (await f.choose())!; const { source } = f.start();
  const binding = await f.service.fileScopes.bind(source, grant.grantId, 'input.txt', 'read');
  await rename(join(f.root, 'input.txt'), join(f.root, 'old'));
  await symlink(join(f.outside, 'secret.txt'), join(f.root, 'input.txt'));
  await assert.rejects(f.service.fileScopes.verify(binding));
  await rename(f.root, join(f.directory, 'old-root')); await mkdir(f.root);
  await writeFile(join(f.root, 'input.txt'), 'replacement'); await assert.rejects(f.service.fileScopes.verify(binding));
});
test('read-write range only binds targets; it does not write files or grant a tool approval', async t => {
  const f = await scopeFixture(t); const grant = (await f.choose({ mode: 'read-write', remember: false }))!;
  const { source } = f.start(); const bound = await f.service.fileScopes.bind(source, grant.grantId, 'new.txt', 'write');
  assert.equal((await f.service.fileScopes.verify(bound)).stat, undefined);
  assert.deepEqual(f.service.getSnapshot(f.session.sessionId).runs[0]!.approvals ?? [], []);
});

test('Windows native and slash paths retain identity checks and reject traversal, streams and device aliases', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = await scopeFixture(t); const grant = (await f.choose({ mode: 'read-write', remember: false }))!;
  const { source } = f.start();
  for (const input of [join(f.root, 'input.txt'), join(f.root, 'input.txt').replaceAll('\\', '/')]) {
    const binding = await f.service.fileScopes.bind(source, grant.grantId, input, 'read');
    assert.equal(binding.path, join(f.root, 'input.txt')); assert.ok((await f.service.fileScopes.verify(binding)).stat?.isFile());
  }
  for (const input of ['..\\outside\\secret.txt', 'nested/..\\input.txt', 'input.txt:stream', '.ssh.\\key',
    'input.txt ', 'NUL.txt', 'COM¹', 'C:relative.txt', `\\\\?\\${f.root}\\input.txt`, '\\\\.\\PhysicalDrive0']) {
    await assert.rejects(f.service.fileScopes.bind(source, grant.grantId, input, 'write'), { code: 'FILE_SCOPE_DENIED' });
  }
});
