import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteSessionStore } from '../src/index.js';
import { startPending } from './helpers/conversation.js';
import { storageFixture } from './helpers/storage.js';

test('optimistic versions reject stale writes without overwriting newer records', async t => {
  const f = await storageFixture(t);
  const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  const stale = f.store.load()[0]!;
  const other = new SqliteSessionStore(f.path); t.after(() => other.close());
  const latest = structuredClone(stale); latest.session.version++;
  latest.session.title = 'other writer';
  other.save(latest, stale.session.version);
  stale.session.version++;
  assert.throws(() => f.store.save(stale, stale.session.version - 1), { code: 'VERSION_CONFLICT' });
  assert.equal(other.load()[0]!.session.title, 'other writer');
  const handle = f.service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending();
  assert.equal(f.calls.length, 0);
  handle.cancel(); await handle.done;
  assert.equal(f.service.retrySave(sessionId).status, 'failed');
  assert.equal(other.load()[0]!.messages.length, 0);
});

test('message identities cannot be reassigned to another session', async t => {
  const f = await storageFixture(t);
  const firstId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  const first = f.service.send({ sessionId: firstId, clientMessageId: 'one', text: 'question' });
  await startPending(); f.calls[0]!.finish(); await first.done;
  const secondId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  const [original, empty] = f.store.load();
  assert.ok(original && empty);
  empty.session.version++;
  empty.messages = original.messages.map(message => ({ ...message, sessionId: secondId }));
  empty.runs = original.runs.map(run => ({ ...run, sessionId: secondId, runId: 'new-run' }));
  assert.throws(() => f.store.save(empty, empty.session.version - 1), { code: 'INVALID_DATA' });
  assert.equal(f.store.load()[0]!.messages[0]!.sessionId, firstId);
  assert.equal(f.store.load()[1]!.messages.length, 0);
});

test('corrupt JSON and inconsistent record metadata fail closed without resetting history', async t => {
  const f = await storageFixture(t);
  const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  f.faults.prepare('UPDATE sessions SET record = ? WHERE session_id = ?').run('{broken', sessionId);
  assert.throws(() => f.store.load(), { code: 'READ_FAILED' });
  assert.equal(f.faults.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count, 1);
  f.faults.prepare('UPDATE sessions SET record = ? WHERE session_id = ?')
    .run(JSON.stringify({ ...f.service.getSnapshot(sessionId).session, sessionId: 'wrong-id' }), sessionId);
  assert.throws(() => f.store.load(), { code: 'INVALID_DATA' });
});

test('unknown schema versions are rejected without modifying the database', async t => {
  const f = await storageFixture(t);
  await f.service.dispose();
  f.faults.exec('PRAGMA user_version = 99');
  assert.throws(() => new SqliteSessionStore(f.path), { code: 'UNSUPPORTED_SCHEMA' });
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 99);
});
