import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpRunFixture } from './helpers/mcp-run.js';
import { deadline } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';
import { SqliteSessionStore } from '../src/index.js';

test('failed MCP snapshot save blocks the first model request until save retry', async t => {
  const f = await mcpRunFixture(t);
  f.faults.exec(`CREATE TRIGGER fail_snapshot BEFORE UPDATE ON runs
    WHEN json_array_length(json_extract(NEW.record, '$.toolsSnapshot')) > 0 BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
  const h = f.send(); await waitUntil(() => f.snapshot().saveState.status === 'failed');
  assert.equal(f.server.requests.length, 0); assert.equal(f.actions(), 0);
  f.faults.exec('DROP TRIGGER fail_snapshot'); f.service.retrySave(f.sessionId);
  await f.decide(); assert.equal((await deadline(h.done, 5000)).status, 'completed'); assert.equal(f.actions(), 1);
});

test('failed MCP intent save blocks tools/call; result save retry does not replay tools/call', async t => {
  for (const boundary of ['intent', 'result'] as const) {
    const f = await mcpRunFixture(t);
    f.faults.exec(boundary === 'intent' ? `CREATE TRIGGER fail_boundary BEFORE UPDATE ON tool_calls WHEN NEW.status = 'running'
      BEGIN SELECT RAISE(ABORT, 'fixture'); END` : `CREATE TRIGGER fail_boundary BEFORE INSERT ON run_messages
      WHEN json_extract(NEW.record, '$.message.role') = 'toolResult' BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
    const h = f.send(); await f.decide(); await waitUntil(() => f.snapshot().saveState.status === 'failed');
    assert.equal(f.actions(), boundary === 'intent' ? 0 : 1); assert.equal(f.server.requests.length, 1);
    f.faults.exec('DROP TRIGGER fail_boundary'); f.service.retrySave(f.sessionId);
    assert.equal((await deadline(h.done, 5000)).status, 'completed'); assert.equal(f.actions(), 1);
  }
});

test('MCP provenance is validated on load and cannot be rewritten in a saved run', async t => {
  const f = await mcpRunFixture(t); const h = f.send(); await f.decide(); await deadline(h.done, 5000);
  const data = f.store.load()[0]!;
  const changed = structuredClone(data); changed.session.version++;
  (changed.runs[0]!.toolsSnapshot![0]!.origin as { toolName: string }).toolName = 'different';
  assert.throws(() => f.store.save(changed, data.session.version));
  f.faults.exec(`UPDATE runs SET record = json_set(record, '$.toolsSnapshot[0].origin.schemaDigest', 'invalid')`);
  const next = new SqliteSessionStore(f.path);
  try { assert.throws(() => next.load()); } finally { next.close(); }
});

test('v7 plain conversation migrates to the current schema without changing saved messages', async t => {
  const f = await mcpRunFixture(t);
  const before = f.store.load(); f.faults.exec('PRAGMA user_version = 7');
  const migrated = new SqliteSessionStore(f.path);
  try { assert.deepEqual(migrated.load(), before); assert.equal(f.faults.prepare('PRAGMA user_version').get()!.user_version, 9); }
  finally { migrated.close(); }
});
