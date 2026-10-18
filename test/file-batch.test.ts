import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { mutationFixture, mutationDecision } from './helpers/mutation-loop.js';
import { toolReply } from './helpers/tool-loop.js';
import { beginSse, chatChunk, deadline } from './helpers/server.js';
import { seedBatch, batchReference, reopenBatch } from './helpers/file-batch.js';
import type { ConversationHandle } from '../src/conversation/types.js';
import { validateStored } from '../src/storage/validation.js';
const names = ['note.txt', 'second.txt', 'third.txt'];
const reads = (files = names) => files.map((path, i) => ({ id: `r${i}`, name: 'read', args: { path } }));
const writes = (files = names) => files.map((path, i) => ({ id: `w${i}`, name: 'write', args: { path, content: `updated ${path}\n` } }));
const answer = (response: Parameters<typeof beginSse>[0]) => {
  beginSse(response); chatChunk(response, { role: 'assistant', content: 'done' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
};

test('one batch decision authorizes distinct Pi calls, rejects forged digests and persists each actual outcome', async t => {
  let turn = 0; const f = await mutationFixture(t, response => ++turn === 1 ? toolReply(response, reads())
    : turn === 2 ? toolReply(response, writes()) : answer(response), {}, 120_000, { account: true });
  await seedBatch(f.root); const handle = f.send(); const leader = await f.approval();
  assert.equal(leader.batchPlan!.members.length, 3);
  const pending = f.service.getSnapshot(f.sessionId).runs[0]!.approvals!;
  assert.equal(pending.filter(a => a.batchPlan).length, 1);
  for (const name of names) assert.equal(await readFile(join(f.root, name), 'utf8'), `original ${name}\n`);
  assert.throws(() => f.service.decideApproval({ ...mutationDecision(leader), batchDigest: 'forged' }));
  assert.throws(() => f.service.decideApproval(mutationDecision(pending[1]!)));
  f.service.decideApproval(mutationDecision(leader)); f.service.decideApproval(mutationDecision(leader));
  const result = await deadline(handle.done, 10_000); assert.equal(result.status, 'completed', result.error?.message);
  assert.ok(result.toolCalls!.every(c => c.status === 'succeeded')); assert.deepEqual(f.store.load()[0]!.runs[0]!.approvals, result.approvals);
  for (const name of names) assert.equal(await readFile(join(f.root, name), 'utf8'), `updated ${name}\n`);
  const tampered = structuredClone(f.store.load()[0]!); tampered.runs[0]!.approvals![0]!.batchPlan!.members[1]!.path = '/different';
  assert.throws(() => validateStored(tampered));
});

test('batch preflight rejects canonical duplicate targets before any member is executed', async t => {
  let turn = 0; const f = await mutationFixture(t, response => ++turn === 1 ? toolReply(response, reads(['note.txt']))
    : turn === 2 ? toolReply(response, writes(['note.txt', 'alias.txt'])) : answer(response), {}, 120_000, { account: true });
  await seedBatch(f.root); await symlink(join(f.root, 'note.txt'), join(f.root, 'alias.txt'));
  const result = await deadline(f.send().done, 10_000);
  assert.equal(result.approvals!.length, 0); assert.ok(result.toolCalls!.slice(1).every(c => c.status === 'rejected'));
  assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), 'original note.txt\n');
});

for (const action of ['reject', 'stop', 'expire'] as const) {
  test(`batch ${action} blocks every member without treating the conversation as globally authorized`, async t => {
    let turn = 0; const f = await mutationFixture(t, response => ++turn === 1 ? toolReply(response, reads())
      : turn === 2 ? toolReply(response, writes()) : answer(response), {}, action === 'expire' ? 100 : 120_000, { account: true });
    await seedBatch(f.root); const handle = f.send(); const receipt = await f.approval();
    if (action === 'reject') f.service.decideApproval(mutationDecision(receipt, 'reject'));
    if (action === 'stop') handle.cancel();
    const result = await deadline(handle.done, 10_000); assert.ok(result.approvals!.every(a => a.status !== 'approved'));
    for (const name of names) assert.equal(await readFile(join(f.root, name), 'utf8'), `original ${name}\n`);
  });
}

test('stopping after the first commit restores only unfinished operations and requires fresh batch confirmation', async t => {
  let turn = 0; let publications = 0; let handle!: ConversationHandle;
  const f = await mutationFixture(t, response => {
    ++turn;
    if (turn === 1) toolReply(response, reads()); else if (turn === 2) toolReply(response, writes());
    else if (turn === 3) toolReply(response, reads(names.slice(1))); else if (turn === 4) toolReply(response, writes(names.slice(1))); else answer(response);
  }, { afterCommit: async () => { if (++publications === 1) handle.cancel(); } }, 120_000, { account: true });
  await seedBatch(f.root); handle = f.send(); const first = await f.approval(); f.service.decideApproval(mutationDecision(first));
  const stopped = await deadline(handle.done, 10_000);
  assert.equal(stopped.toolCalls!.find(c => c.toolCallId === 'w0')!.status, 'succeeded');
  assert.ok(stopped.toolCalls!.filter(c => ['w1', 'w2'].includes(c.toolCallId)).every(c => c.status === 'interrupted'));
  const restored = await reopenBatch(t, f); const resumed = restored.service.resumeBatch(batchReference(first));
  const second = await restored.approval(); assert.equal(second.batchPlan!.members.length, 2);
  assert.ok(second.batchPlan!.members.every(m => !m.path.endsWith('/note.txt'))); assert.notEqual(second.batchPlan!.digest, first.batchPlan!.digest);
  assert.throws(() => restored.service.decideApproval(mutationDecision(first)));
  restored.service.decideApproval(mutationDecision(second)); assert.equal((await deadline(resumed.done, 10_000)).status, 'completed');
  assert.throws(() => restored.service.resumeBatch(batchReference(first)), /没有需要恢复/);
  for (const name of names) assert.equal(await readFile(join(f.root, name), 'utf8'), `updated ${name}\n`);
});

test('a changed later target stops the batch while preserving already committed members', async t => {
  let turn = 0; let commits = 0;
  const f = await mutationFixture(t, response => ++turn === 1 ? toolReply(response, reads())
    : turn === 2 ? toolReply(response, writes()) : answer(response),
  { afterCommit: async () => { if (++commits === 1) await writeFile(join(f.root, 'second.txt'), 'external'); } }, 120_000, { account: true });
  await seedBatch(f.root); const handle = f.send(); f.service.decideApproval(mutationDecision(await f.approval()));
  const result = await deadline(handle.done, 10_000); assert.equal(commits, 1);
  assert.equal(result.toolCalls!.find(c => c.toolCallId === 'w1')!.status, 'failed');
  assert.equal(result.toolCalls!.find(c => c.toolCallId === 'w2')!.status, 'interrupted');
  assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), 'updated note.txt\n');
  assert.equal(await readFile(join(f.root, 'second.txt'), 'utf8'), 'external');
  assert.equal(await readFile(join(f.root, 'third.txt'), 'utf8'), 'original third.txt\n');
});

test('unknown publication outcome blocks batch recovery instead of assuming failure or replaying writes', async t => {
  let turn = 0; const f = await mutationFixture(t, response => ++turn === 1 ? toolReply(response, reads())
    : turn === 2 ? toolReply(response, writes()) : answer(response),
  { afterCommit: async () => { throw new Error('post-publication fault'); } }, 120_000, { account: true });
  await seedBatch(f.root); const handle = f.send(); const receipt = await f.approval(); f.service.decideApproval(mutationDecision(receipt));
  const result = await deadline(handle.done, 10_000); assert.equal(result.toolCalls!.find(c => c.toolCallId === 'w0')!.status, 'outcome_unknown');
  assert.throws(() => f.service.resumeBatch(batchReference(receipt)), /结果未知/);
  assert.equal(await readFile(join(f.root, 'second.txt'), 'utf8'), 'original second.txt\n');
});

test('a batch of ordinary new files executes automatically with policy receipts and no user confirmation', async t => {
  let turn = 0; const f = await mutationFixture(t, response => ++turn === 1 ? toolReply(response, writes(['new-a.txt', 'new-b.txt']))
    : answer(response), {}, 120_000, { account: true });
  const result = await deadline(f.send().done, 10_000);
  assert.equal(result.status, 'completed'); assert.equal(result.approvals!.length, 2);
  assert.ok(result.approvals!.every(a => a.status === 'approved' && a.inspection?.decision === 'allow'));
  assert.equal(result.approvals!.filter(a => a.batchPlan).length, 1);
  assert.equal(await readFile(join(f.root, 'new-b.txt'), 'utf8'), 'updated new-b.txt\n');
});
