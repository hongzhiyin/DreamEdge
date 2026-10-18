import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteSessionStore } from '../src/index.js';
import { toolConversation, toolStoreFixture } from './helpers/tool-storage.js';

async function legacyFixture(t: Parameters<typeof toolStoreFixture>[0]) {
  const f = await toolStoreFixture(t); f.store.close();
  f.faults.exec('DROP TABLE tool_calls; DROP TABLE run_messages; PRAGMA user_version = 1');
  const data = toolConversation(); const run = data.runs[0]!;
  const { transcript: _trace, toolCalls: _calls, approvals: _grants, toolsSnapshot: _tools, ...legacy } = run;
  delete legacy.modelConfigSnapshot.toolCalling;
  f.faults.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s', data.session.version, JSON.stringify(data.session));
  f.faults.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)').run('u', 's', 'client-1', 0, JSON.stringify(data.messages[0]));
  f.faults.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)').run('r', 's', 'u', 0, 'completed', JSON.stringify(legacy));
  return { ...f, legacy, data };
}

test('v1 migration preserves user/run identities, versions and original native metadata', async t => {
  const f = await legacyFixture(t); const store = f.open();
  const data = store.load()[0]!; const run = data.runs[0]!;
  assert.equal(f.faults.prepare('PRAGMA user_version').get()?.user_version, 9);
  assert.deepEqual(data.session, f.data.session); assert.deepEqual(data.messages, f.data.messages);
  assert.equal(run.runId, f.legacy.runId); assert.deepEqual(run.nativeMessage, f.legacy.nativeMessage);
  assert.deepEqual(run.transcript!.map(entry => entry.message), [f.legacy.nativeMessage]);
  assert.deepEqual(run.toolCalls, []);
  store.close(); assert.deepEqual(f.open().load(), [data]);
});

test('migration failure rolls back child tables, record conversion and schema version', async t => {
  const f = await legacyFixture(t);
  f.faults.exec(`CREATE TRIGGER fail_migration BEFORE UPDATE ON runs
    BEGIN SELECT RAISE(ABORT, 'fixture migration failure'); END`);
  assert.throws(() => new SqliteSessionStore(f.path), { code: 'MIGRATION_FAILED' });
  assert.equal(f.faults.prepare('PRAGMA user_version').get()?.user_version, 1);
  assert.equal(f.faults.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('run_messages', 'tool_calls')").get()?.count, 0);
  assert.deepEqual(JSON.parse(String(f.faults.prepare('SELECT record FROM runs').get()?.record)), f.legacy);
  f.faults.exec('DROP TRIGGER fail_migration');
  assert.equal(f.open().load().length, 1);
});
