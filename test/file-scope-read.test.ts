import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, rename, symlink, link, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readScopedFile } from '../src/index.js';
import { scopeFixture } from './helpers/file-scopes.js';

test('descriptor read records hash and identity atomically with the owning conversation', async t => {
  const f = await scopeFixture(t); const grant = (await f.choose({ mode: 'read', remember: true }))!;
  const { source } = f.start(); const binding = await f.service.fileScopes.bind(source, grant.grantId, 'input.txt', 'read');
  const result = await readScopedFile(f.service.fileScopes, binding, new AbortController().signal);
  assert.equal(result.data.toString(), 'authorized contents\n'); assert.equal(result.observation.version.sha256.length, 64);
  assert.equal(result.observation.complete, true);
  const store = f.open(); assert.equal(store.fileScopes.snapshot(f.session.sessionId).observations[0]!.version.sha256, result.observation.version.sha256);
});
test('oversized files and pre-cancelled reads produce no observation', async t => {
  const f = await scopeFixture(t); const grant = (await f.choose())!; const { source } = f.start();
  const binding = await f.service.fileScopes.bind(source, grant.grantId, 'input.txt', 'read');
  await assert.rejects(readScopedFile(f.service.fileScopes, binding, new AbortController().signal, 2), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(readScopedFile(f.service.fileScopes, binding, AbortSignal.abort()));
  assert.deepEqual(f.service.fileScopes.snapshot(f.session.sessionId).observations, []);
});
test('substitution and hard-link creation after preflight do not expose outside contents', async t => {
  const f = await scopeFixture(t); const grant = (await f.choose())!; const { source } = f.start();
  const binding = await f.service.fileScopes.bind(source, grant.grantId, 'input.txt', 'read');
  const verify = f.service.fileScopes.verify.bind(f.service.fileScopes); let checks = 0;
  f.service.fileScopes.verify = async b => {
    const target = await verify(b);
    if (++checks === 1) { await rename(b.path, join(f.root, 'old')); await symlink(join(f.outside, 'secret.txt'), b.path); }
    return target;
  };
  await assert.rejects(readScopedFile(f.service.fileScopes, binding, new AbortController().signal));
  assert.deepEqual(f.service.fileScopes.snapshot(f.session.sessionId).observations, []);
});
test('concurrent modification is detected before releasing content or observation', async t => {
  const f = await scopeFixture(t); const grant = (await f.choose())!; const { source } = f.start();
  const binding = await f.service.fileScopes.bind(source, grant.grantId, 'input.txt', 'read');
  const verify = f.service.fileScopes.verify.bind(f.service.fileScopes); let checks = 0;
  f.service.fileScopes.verify = async b => { const value = await verify(b); if (++checks === 3) await writeFile(b.path, 'changed'); return value; };
  await assert.rejects(readScopedFile(f.service.fileScopes, binding, new AbortController().signal), { code: 'FILE_CHANGED' });
  assert.deepEqual(f.service.fileScopes.snapshot(f.session.sessionId).observations, []);
});
test('revocation or cancellation during read cannot publish a successful result', async t => {
  for (const cancel of [true, false]) {
    const f = await scopeFixture(t); const grant = (await f.choose())!; const { source } = f.start();
    const binding = await f.service.fileScopes.bind(source, grant.grantId, 'input.txt', 'read'); const controller = new AbortController();
    const verify = f.service.fileScopes.verify.bind(f.service.fileScopes); let checks = 0;
    f.service.fileScopes.verify = async b => { const value = await verify(b); if (++checks === 2) {
      if (cancel) controller.abort(); else f.service.fileScopes.revoke(f.session.sessionId, grant.grantId);
    } return value; };
    await assert.rejects(readScopedFile(f.service.fileScopes, binding, controller.signal));
    assert.deepEqual(f.service.fileScopes.snapshot(f.session.sessionId).observations, []);
  }
});

test('parent link substitution and late hard links are rejected before content publication', async t => {
  for (const hard of [false, true]) {
    const f = await scopeFixture(t); await mkdir(join(f.root, 'sub')); await writeFile(join(f.root, 'sub', 'secret.txt'), 'inside');
    const grant = (await f.choose())!; const { source } = f.start();
    const binding = await f.service.fileScopes.bind(source, grant.grantId, 'sub/secret.txt', 'read');
    const verify = f.service.fileScopes.verify.bind(f.service.fileScopes); let checks = 0;
    f.service.fileScopes.verify = async b => { const value = await verify(b); if (++checks === 1) {
      if (hard) await link(b.path, join(f.outside, 'late-hard'));
      else { await rename(join(f.root, 'sub'), join(f.root, 'old-sub')); await symlink(f.outside, join(f.root, 'sub')); }
    } return value; };
    await assert.rejects(readScopedFile(f.service.fileScopes, binding, new AbortController().signal));
    assert.deepEqual(f.service.fileScopes.snapshot(f.session.sessionId).observations, []);
  }
});
