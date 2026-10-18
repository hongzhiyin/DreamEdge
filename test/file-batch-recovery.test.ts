import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mutationFixture, mutationDecision } from './helpers/mutation-loop.js';
import { toolReply } from './helpers/tool-loop.js';
import { beginSse, chatChunk, deadline } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';
import { seedBatch, batchReference, reopenBatch } from './helpers/file-batch.js';
import type { StoredConversation } from '../src/storage/types.js';
import type { ConversationHandle } from '../src/conversation/types.js';
import { recoverToolRun } from '../src/conversation/tool-recovery.js';
import { validateStored } from '../src/storage/validation.js';
const names = ['note.txt', 'second.txt'];
const reads = names.map((path, i) => ({ id: `r${i}`, name: 'read', args: { path } }));
const writes = names.map((path, i) => ({ id: `w${i}`, name: 'write', args: { path, content: `changed ${path}` } }));
const answer = (response: Parameters<typeof beginSse>[0]) => {
  beginSse(response); chatChunk(response, { role: 'assistant', content: 'done' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
};

test('batch grant persistence failure and stop cannot publish or replay any member', async t => {
  let turn = 0; const f = await mutationFixture(t, response => ++turn === 1 ? toolReply(response, reads)
    : turn === 2 ? toolReply(response, writes) : answer(response), {}, 120_000, { account: true });
  await seedBatch(f.root); const handle = f.send(); const receipt = await f.approval();
  const db = new DatabaseSync(join(f.directory, 'sessions.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_batch BEFORE UPDATE ON tool_calls WHEN NEW.status = 'authorized' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    f.service.decideApproval(mutationDecision(receipt));
    await waitUntil(() => f.service.getSnapshot(f.sessionId).saveState.status === 'failed');
    assert.ok(f.store.load()[0]!.runs[0]!.approvals!.every(a => a.status === 'pending'));
    handle.cancel(); await deadline(handle.done, 5000); db.exec('DROP TRIGGER fail_batch'); f.service.retrySave(f.sessionId);
    assert.equal(f.service.getSnapshot(f.sessionId).saveState.status, 'saved');
    for (const name of names) assert.equal(await readFile(join(f.root, name), 'utf8'), `original ${name}\n`);
  } finally { db.exec('DROP TRIGGER IF EXISTS fail_batch'); db.close(); }
});

test('crash snapshot distinguishes an executing write from authorized but unstarted members', async t => {
  let turn = 0; let captured: StoredConversation | undefined; let handle!: ConversationHandle;
  const f = await mutationFixture(t, response => ++turn === 1 ? toolReply(response, reads)
    : turn === 2 ? toolReply(response, writes) : answer(response),
  { beforePublish: async () => { captured = f.store.load()[0]!; handle.cancel(); } }, 120_000, { account: true });
  await seedBatch(f.root); handle = f.send(); f.service.decideApproval(mutationDecision(await f.approval())); await handle.done;
  assert.ok(captured); const run = captured.runs[0]!;
  assert.equal(run.toolCalls!.find(c => c.toolCallId === 'w0')!.status, 'running');
  assert.equal(run.toolCalls!.find(c => c.toolCallId === 'w1')!.status, 'authorized');
  assert.equal(recoverToolRun(run, Date.now()), true); run.status = 'interrupted'; validateStored(captured);
  assert.equal(run.toolCalls!.find(c => c.toolCallId === 'w0')!.status, 'outcome_unknown');
  assert.equal(run.toolCalls!.find(c => c.toolCallId === 'w1')!.status, 'interrupted');
  assert.equal(await readFile(join(f.root, 'second.txt'), 'utf8'), 'original second.txt\n');
});

test('recovery is host-scoped: an extra model-proposed write is blocked before any recovery mutation', async t => {
  let turn = 0; const f = await mutationFixture(t, response => {
    ++turn;
    if (turn === 1) toolReply(response, reads); else if (turn === 2) toolReply(response, writes);
    else if (turn === 4) toolReply(response, [writes[0]!, { id: 'escape', name: 'write', args: { path: 'extra.txt', content: 'unapproved' } }]);
    else answer(response);
  }, {}, 120_000, { account: true });
  await seedBatch(f.root); const handle = f.send(); const receipt = await f.approval();
  f.service.decideApproval(mutationDecision(receipt, 'reject')); await handle.done;
  assert.throws(() => f.service.resumeBatch({ ...batchReference(receipt), digest: 'forged' }));
  const result = await deadline(f.service.resumeBatch(batchReference(receipt)).done, 10_000);
  assert.equal(result.approvals!.length, 0); assert.ok(result.toolCalls!.every(call => call.status === 'rejected'));
  await assert.rejects(access(join(f.root, 'extra.txt'))); assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), 'original note.txt\n');
});

test('a later model turn is not covered by the previously approved batch', async t => {
  let turn = 0; const f = await mutationFixture(t, response => ++turn === 1 ? toolReply(response, reads)
    : turn === 2 ? toolReply(response, writes) : turn === 3 ? toolReply(response, [{ ...writes[0]!, id: 'late', args: { path: 'note.txt', content: 'different' } }])
      : answer(response), {}, 120_000, { account: true });
  await seedBatch(f.root); const handle = f.send(); f.service.decideApproval(mutationDecision(await f.approval()));
  await waitUntil(() => f.service.getSnapshot(f.sessionId).runs[0]!.approvals!.some(a => a.toolCallId === 'late' && a.status === 'pending'));
  const late = f.service.getSnapshot(f.sessionId).runs[0]!.approvals!.find(a => a.toolCallId === 'late')!;
  assert.equal(late.batch, undefined); assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), 'changed note.txt');
  f.service.decideApproval(mutationDecision(late, 'reject')); await handle.done;
});

test('v5 account records migrate to v6 without changing existing grants or history', async t => {
  const f = await mutationFixture(t, response => answer(response), {}, 120_000, { account: true });
  await f.send().done; const before = f.store.load(); await f.service.dispose();
  const db = new DatabaseSync(join(f.directory, 'sessions.sqlite')); db.exec('PRAGMA user_version = 5'); db.close();
  const restored = await reopenBatch(t, f); assert.deepEqual(restored.store.load(), before);
});
