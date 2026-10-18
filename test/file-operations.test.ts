import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { operationFixture } from './helpers/file-operations.js';
import { mutationDecision } from './helpers/mutation-loop.js';
import { toolReply } from './helpers/tool-loop.js';
import { beginSse, chatChunk, deadline } from './helpers/server.js';
import type { ConversationHandle } from '../src/conversation/types.js';
const answer = (response: Parameters<typeof beginSse>[0]) => {
  beginSse(response); chatChunk(response, { role: 'assistant', content: 'done' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
};

for (const permanent of [false, true]) test(`delete uses ${permanent ? 'explicit permanent removal' : 'trash by default'} only after the actual plan is approved`, async t => {
  let turn = 0; const f = await operationFixture(t, response => ++turn === 1
    ? toolReply(response, [{ id: 'd', name: 'delete', args: { path: 'note.txt', ...(permanent ? { permanent: true } : {}) } }]) : answer(response));
  const handle = f.send(); const receipt = await f.approval();
  assert.equal(f.service.getSnapshot(f.sessionId).runs[0]!.toolCalls![0]!.preview?.operation, permanent ? 'delete' : 'trash');
  assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), 'alpha\nbeta\n');
  f.service.decideApproval(mutationDecision(receipt)); const result = await deadline(handle.done, 10_000);
  assert.equal(result.status, 'completed', result.error?.message); assert.equal(result.toolCalls![0]!.status, 'succeeded');
  await assert.rejects(access(join(f.root, 'note.txt'))); assert.equal(f.trashed(), permanent ? 0 : 1);
  assert.deepEqual(f.store.load()[0]!.runs[0]!.toolCalls, result.toolCalls);
});

test('permanent directory removal enumerates the full tree and mixed deletes share one batch approval', async t => {
  let turn = 0; const f = await operationFixture(t, response => ++turn === 1 ? toolReply(response, [
    { id: 'a', name: 'delete', args: { path: 'tree', permanent: true } }, { id: 'b', name: 'delete', args: { path: 'note.txt' } },
  ]) : answer(response));
  await mkdir(join(f.root, 'tree/sub'), { recursive: true }); await writeFile(join(f.root, 'tree/sub/binary'), Buffer.from([0, 255, 2]));
  const handle = f.send(); const receipt = await f.approval(); assert.equal(receipt.batchPlan?.members.length, 2);
  const preview = f.service.getSnapshot(f.sessionId).runs[0]!.toolCalls![0]!.preview!;
  assert.ok(preview.kind === 'file_operation'); assert.equal(preview.tree!.entries.length, 3);
  f.service.decideApproval(mutationDecision(receipt)); const result = await handle.done;
  assert.ok(result.toolCalls!.every(c => c.status === 'succeeded')); await assert.rejects(access(join(f.root, 'tree'))); assert.equal(f.trashed(), 1);
});

for (const name of ['copy', 'move'] as const) test(`${name} handles binary directory contents without overwriting and preserves the actual destination`, async t => {
  let turn = 0; const f = await operationFixture(t, response => ++turn === 1
    ? toolReply(response, [{ id: 'op', name, args: { path: 'source', destination: 'target' } }]) : answer(response));
  await mkdir(join(f.root, 'source/sub'), { recursive: true }); const bytes = Buffer.from([0, 255, 4, 5]);
  await writeFile(join(f.root, 'source/sub/binary'), bytes);
  const result = await deadline(f.send().done, 10_000);
  assert.equal(result.toolCalls![0]!.status, 'succeeded', JSON.stringify(result.toolCalls));
  assert.equal(result.approvals![0]!.inspection!.decision, 'allow'); assert.deepEqual(await readFile(join(f.root, 'target/sub/binary')), bytes);
  if (name === 'move') await assert.rejects(access(join(f.root, 'source'))); else await access(join(f.root, 'source'));
});

test('mkdir is exclusive, and an existing copy/move destination is never overwritten', async t => {
  let turn = 0; const f = await operationFixture(t, response => {
    if (++turn === 1) toolReply(response, [{ id: 'dir', name: 'mkdir', args: { path: 'new-directory' } }]);
    else if (turn === 2) toolReply(response, [{ id: 'move', name: 'move', args: { path: 'note.txt', destination: 'existing.txt' } }]);
    else answer(response);
  });
  await writeFile(join(f.root, 'existing.txt'), 'existing'); const result = await f.send().done;
  assert.equal(result.toolCalls![0]!.status, 'succeeded'); assert.equal(result.toolCalls![1]!.status, 'rejected');
  assert.deepEqual(await readdir(join(f.root, 'new-directory')), []); assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'existing');
  assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), 'alpha\nbeta\n');
});

test('a protected child, a final symlink and overlapping source/destination claims reject the whole operation', async t => {
  for (const scenario of ['secret', 'link', 'overlap'] as const) {
    let turn = 0; const f = await operationFixture(t, response => ++turn === 1 ? toolReply(response, scenario === 'overlap' ? [
      { id: 'd', name: 'delete', args: { path: 'tree', permanent: true } },
      { id: 'c', name: 'copy', args: { path: 'note.txt', destination: 'tree/child' } },
    ] : [{ id: 'd', name: 'delete', args: { path: scenario === 'link' ? 'alias' : 'tree', permanent: true } }]) : answer(response));
    await mkdir(join(f.root, 'tree')); if (scenario === 'secret') await writeFile(join(f.root, 'tree/.env'), 'protected');
    if (scenario === 'link') await symlink(join(f.root, 'note.txt'), join(f.root, 'alias'));
    const result = await f.send().done; assert.equal(result.approvals!.length, 0);
    assert.ok(result.toolCalls!.every(c => c.status === 'rejected')); await access(join(f.root, 'tree')); await access(join(f.root, 'note.txt'));
  }
});

test('changed tree contents after approval fail before deletion, including newly introduced children', async t => {
  let turn = 0; const f = await operationFixture(t, response => ++turn === 1
    ? toolReply(response, [{ id: 'd', name: 'delete', args: { path: 'tree', permanent: true } }]) : answer(response),
  { beforeCommit: async () => { await writeFile(join(f.root, 'tree/new.txt'), 'new external data'); } });
  await mkdir(join(f.root, 'tree')); await writeFile(join(f.root, 'tree/original.txt'), 'original');
  const handle = f.send(); f.service.decideApproval(mutationDecision(await f.approval())); const result = await handle.done;
  assert.equal(result.toolCalls![0]!.status, 'failed'); assert.deepEqual((await readdir(join(f.root, 'tree'))).sort(), ['new.txt', 'original.txt']);
});

test('stop after a confirmed native trash result retains success and does not run remaining batch members', async t => {
  let turn = 0; let handle!: ConversationHandle;
  const f = await operationFixture(t, response => ++turn === 1 ? toolReply(response, [
    { id: 'a', name: 'delete', args: { path: 'note.txt' } }, { id: 'b', name: 'delete', args: { path: 'second.txt' } },
  ]) : answer(response), { afterCommit: async () => { handle.cancel(); } });
  await writeFile(join(f.root, 'second.txt'), 'keep'); handle = f.send(); f.service.decideApproval(mutationDecision(await f.approval()));
  const result = await handle.done; assert.equal(result.toolCalls![0]!.status, 'succeeded'); assert.equal(result.toolCalls![1]!.status, 'interrupted');
  assert.equal(await readFile(join(f.root, 'second.txt'), 'utf8'), 'keep'); assert.equal(f.trashed(), 1);
});

test('trash failure never falls back to permanent deletion or claims a known failure after native execution', async t => {
  let turn = 0; const f = await operationFixture(t, response => ++turn === 1
    ? toolReply(response, [{ id: 'd', name: 'delete', args: { path: 'note.txt' } }]) : answer(response),
  { trash: async () => { throw new Error('native trash failure'); } });
  const handle = f.send(); f.service.decideApproval(mutationDecision(await f.approval())); const result = await handle.done;
  assert.equal(result.toolCalls![0]!.status, 'outcome_unknown'); await access(join(f.root, 'note.txt'));
});
