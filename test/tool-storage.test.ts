import assert from 'node:assert/strict';
import test from 'node:test';
import { argumentsDigest } from '../src/index.js';
import { pendingConversation, toolConversation, toolStoreFixture } from './helpers/tool-storage.js';

test('SQLite v2 round-trips ordered native tool messages, results and approval receipts', async t => {
  const f = await toolStoreFixture(t);
  const data = toolConversation('write');
  f.store.save(data, null);
  assert.equal(f.faults.prepare('PRAGMA user_version').get()?.user_version, 9);
  assert.equal(f.faults.prepare('SELECT COUNT(*) AS count FROM run_messages').get()?.count, 3);
  assert.equal(f.faults.prepare('SELECT COUNT(*) AS count FROM tool_calls').get()?.count, 1);
  f.store.close();
  assert.deepEqual(f.open().load(), [data]);
});

test('tool-row failure rolls back the session, parent run and every child record', async t => {
  const f = await toolStoreFixture(t);
  f.faults.exec(`CREATE TRIGGER fail_tools BEFORE INSERT ON tool_calls
    BEGIN SELECT RAISE(ABORT, 'fixture'); END`);
  assert.throws(() => f.store.save(toolConversation(), null), { code: 'WRITE_FAILED' });
  for (const table of ['sessions', 'messages', 'runs', 'run_messages', 'tool_calls']) {
    assert.equal(f.faults.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
  }
  f.faults.exec('DROP TRIGGER fail_tools');
  f.store.save(toolConversation(), null);
  assert.equal(f.store.load().length, 1);
});

test('stored tools reject mismatched arguments, orphan results and cross-run approvals', async t => {
  const f = await toolStoreFixture(t);
  const mutations = [
    (data: ReturnType<typeof toolConversation>) => { data.runs[0]!.toolCalls[0]!.args.amount = 9; },
    (data: ReturnType<typeof toolConversation>) => {
      const run = data.runs[0]!;
      run.toolCalls = [{ ...run.toolCalls[0]!, args: { amount: 9 }, argsDigest: argumentsDigest({ amount: 9 }) }];
    },
    (data: ReturnType<typeof toolConversation>) => { data.runs[0]!.transcript = data.runs[0]!.transcript.filter((_, i) => i !== 1); },
    (data: ReturnType<typeof toolConversation>) => { data.runs[0]!.approvals = data.runs[0]!.approvals.map(grant => ({ ...grant, runId: 'other' })); },
    (data: ReturnType<typeof toolConversation>) => { data.runs[0]!.toolsSnapshot = data.runs[0]!.toolsSnapshot.map(tool => ({ ...tool, effect: 'read' })); },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(toolConversation('write')); mutate(data);
    assert.throws(() => f.store.save(data, null), { code: 'INVALID_DATA' });
    assert.equal(f.store.load().length, 0);
  }
});

test('terminal outcomes, sealed messages and enabled definitions cannot be overwritten', async t => {
  const f = await toolStoreFixture(t);
  const data = toolConversation(); f.store.save(data, null);
  for (const change of ['result', 'message', 'snapshot', 'remove']) {
    const changed = structuredClone(data); const run = changed.runs[0]!;
    changed.session.version++;
    if (change === 'result') {
      const call = run.toolCalls[0]!;
      if (call.status === 'succeeded') run.toolCalls = [{ ...call, finishedAt: call.finishedAt + 1 }];
    } else if (change === 'message') run.transcript = run.transcript.map((entry, i) => i === 0
      ? { ...entry, message: { ...entry.message, timestamp: 101 } } : entry);
    else if (change === 'snapshot') run.toolsSnapshot = run.toolsSnapshot.map(tool => ({ ...tool, label: 'changed' }));
    else { run.transcript = []; run.toolCalls = []; run.approvals = []; }
    assert.throws(() => f.store.save(changed, data.session.version), { code: 'INVALID_DATA' });
    assert.deepEqual(f.store.load(), [data]);
  }
});

test('corrupt tool rows fail without clearing the remaining history', async t => {
  const f = await toolStoreFixture(t); f.store.save(toolConversation(), null);
  f.faults.prepare('UPDATE run_messages SET turn_id = ? WHERE message_id = ?').run('other', 'm2');
  assert.throws(() => f.store.load(), { code: 'INVALID_DATA' });
  assert.equal(f.faults.prepare('SELECT COUNT(*) AS count FROM runs').get()?.count, 1);
});

test('approval and execution checkpoints advance atomically through a completed result', async t => {
  const f = await toolStoreFixture(t);
  const waiting = pendingConversation('write', true); f.store.save(waiting, null);
  const running = structuredClone(waiting); running.session.version++;
  running.runs[0]!.approvals = running.runs[0]!.approvals.map(grant => ({ ...grant, status: 'approved', decidedAt: 105 }));
  running.runs[0]!.toolCalls = running.runs[0]!.toolCalls.map(call => ({ ...call, status: 'running', startedAt: 110 }));
  f.store.save(running, waiting.session.version);
  assert.equal(f.store.load()[0]!.runs[0]!.toolCalls![0]!.status, 'running');
  const completed = toolConversation('write'); completed.session.version = 3;
  f.store.save(completed, running.session.version);
  assert.deepEqual(f.store.load(), [completed]);
});
