import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { rename, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SqliteSessionStore } from '../src/index.js';
import { scopeFixture } from './helpers/file-scopes.js';
import { toolConversation, toolStoreFixture } from './helpers/tool-storage.js';

test('v2 migration preserves tool transcripts and does not invent directory authority', async t => {
  const f = await toolStoreFixture(t); const data = toolConversation('write'); f.store.save(data, null); f.store.close();
  f.faults.exec('PRAGMA user_version = 2'); const next = f.open();
  assert.equal(f.faults.prepare('PRAGMA user_version').get()?.user_version, 9); assert.deepEqual(next.load(), [data]);
  assert.equal(next.load()[0]!.session.fileScope, undefined);
});
test('invalid scope in legacy database rolls migration back and retains original data', async t => {
  const f = await toolStoreFixture(t); const data = toolConversation(); f.store.save(data, null); f.store.close();
  f.faults.prepare('UPDATE sessions SET record = ?').run(JSON.stringify({ ...data.session, fileScope: {} }));
  f.faults.exec('PRAGMA user_version = 2');
  assert.throws(() => f.open(), { code: 'INVALID_DATA' }); assert.equal(f.faults.prepare('PRAGMA user_version').get()?.user_version, 2);
});
test('restart revokes temporary grants but revalidates remembered directory identity', async t => {
  const f = await scopeFixture(t); const temporary = (await f.choose())!;
  const remembered = (await f.choose({ mode: 'read-write', remember: true }))!;
  await f.service.dispose(); const restored = f.open(); const scopes = restored.fileScopes.snapshot(f.session.sessionId);
  assert.notEqual(scopes.grants.find(g => g.grantId === temporary.grantId)!.revokedAt, undefined);
  assert.equal(scopes.grants.find(g => g.grantId === remembered.grantId)!.revokedAt, undefined);
  assert.deepEqual(restored.getSnapshot(f.session.sessionId).runs, []);
  const handle = restored.send({ sessionId: f.session.sessionId, clientMessageId: 'restored', text: 'fixture' });
  const source = { sessionId: f.session.sessionId, runId: handle.runId, turnId: 'turn', toolCallId: 'call' };
  await restored.fileScopes.bind(source, remembered.grantId, 'input.txt', 'read');
  await rename(f.root, join(f.directory, 'old')); await mkdir(f.root); await writeFile(join(f.root, 'input.txt'), 'different root');
  await assert.rejects(restored.fileScopes.bind(source, remembered.grantId, 'input.txt', 'read'));
});
test('scope save failure blocks access, retrySave saves without re-running selector', async t => {
  const f = await scopeFixture(t); using db = new DatabaseSync(f.dbPath);
  db.exec(`CREATE TRIGGER scope_failure BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
  await assert.rejects(f.choose(), { code: 'FILE_SCOPE_SAVE_FAILED' });
  assert.equal(f.service.getSnapshot(f.session.sessionId).saveState.status, 'failed');
  await assert.rejects(f.choose(), { code: 'FILE_SCOPE_SAVE_FAILED' });
  db.exec('DROP TRIGGER scope_failure'); f.service.retrySave(f.session.sessionId);
  assert.equal(f.service.fileScopes.snapshot(f.session.sessionId).grants.length, 1);
  assert.equal(f.service.getSnapshot(f.session.sessionId).saveState.status, 'saved');
});
test('SQLite rejects malformed, cross-session or wrong-destination scope records', async t => {
  const f = await scopeFixture(t); await f.choose(); const store = new SqliteSessionStore(':memory:'); t.after(() => store.close());
  const snapshot = f.service.getSnapshot(f.session.sessionId);
  for (const mutate of [(s: typeof snapshot) => { s.session.fileScope!.grants[0]!.sessionId = 'other'; },
    (s: typeof snapshot) => { s.session.fileScope!.grants[0]!.destination.baseUrl = 'https://key:secret@example.com'; },
    (s: typeof snapshot) => { s.session.fileScope!.grants[0]!.identity.inode = 'invalid'; }]) {
    const broken = structuredClone(snapshot); mutate(broken); assert.throws(() => store.save(broken, null), { code: 'INVALID_DATA' });
  }
});
