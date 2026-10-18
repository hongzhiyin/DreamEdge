import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, access, writeFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { mutationFixture, mutationDecision } from './helpers/mutation-loop.js';
import { toolReply } from './helpers/tool-loop.js';
import { beginSse, chatChunk } from './helpers/server.js';
function answer(response: Parameters<typeof beginSse>[0]) { beginSse(response); chatChunk(response, { role: 'assistant', content: 'done' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n'); }

test('new file preview changes nothing before approval; duplicate confirmation publishes exactly once', async t => {
  let turn = 0; let publications = 0;
  const f = await mutationFixture(t, response => ++turn === 1
    ? toolReply(response, [{ id: 'w', name: 'write', args: { path: 'new.txt', content: 'hello\n' } }]) : answer(response),
    { beforePublish: async () => { publications++; } });
  const handle = f.send(); const a = await f.approval();
  const preview = f.service.getSnapshot(f.sessionId).runs[0]!.toolCalls![0]!.preview!;
  assert.equal(preview.operation, 'create'); assert.match(preview.patch, /hello/); await assert.rejects(access(join(f.root, 'new.txt')));
  f.service.decideApproval(mutationDecision(a)); f.service.decideApproval(mutationDecision(a));
  const result = await handle.done; assert.equal(result.status, 'completed'); assert.equal(result.toolCalls![0]!.status, 'succeeded');
  assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'hello\n'); assert.equal(publications, 1);
  assert.deepEqual(f.store.load()[0]!.runs[0]!.approvals, result.approvals);
});
test('Pi edits preserve BOM and CRLF while previewing the exact disjoint edits', async t => {
  let turn = 0;
  const f = await mutationFixture(t, response => {
    if (++turn === 1) toolReply(response, [{ id: 'r', name: 'read', args: { path: 'note.txt' } }]);
    else if (turn === 2) toolReply(response, [{ id: 'e', name: 'edit', args: { path: 'note.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }, { oldText: 'beta', newText: 'BETA' }] } }]);
    else answer(response);
  });
  await writeFile(join(f.root, 'note.txt'), '\ufeffalpha\r\nbeta\r\n');
  const handle = f.send(); const a = await f.approval(); const calls = f.service.getSnapshot(f.sessionId).runs[0]!.toolCalls!;
  assert.match((calls[1]!.preview! as import('../src/files/mutation-types.js').MutationPreview).patch, /ALPHA/); assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), '\ufeffalpha\r\nbeta\r\n');
  f.service.decideApproval(mutationDecision(a)); assert.equal((await handle.done).status, 'completed');
  assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), '\ufeffALPHA\r\nBETA\r\n');
});
test('existing targets cannot be overwritten without a complete successful read', async t => {
  let turn = 0; const f = await mutationFixture(t, response => ++turn === 1
    ? toolReply(response, [{ id: 'w', name: 'write', args: { path: 'note.txt', content: 'blind' } }]) : answer(response));
  const result = await f.send().done; assert.equal(result.status, 'completed'); assert.equal(result.toolCalls![0]!.status, 'rejected');
  assert.deepEqual(result.approvals, []); assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), 'alpha\nbeta\n');
});
test('rejection, missing or altered plan digests and stopped approval never modify the target', async t => {
  for (const stop of [false, true]) {
    let turn = 0; const f = await mutationFixture(t, response => ++turn === 1
      ? toolReply(response, [{ id: 'w', name: 'write', args: { path: 'new.txt', content: 'new' } }]) : answer(response));
    const handle = f.send(); const a = await f.approval(); const command = mutationDecision(a);
    assert.throws(() => f.service.decideApproval({ ...command, planDigest: 'wrong' }));
    const { planDigest: _digest, ...missing } = command; assert.throws(() => f.service.decideApproval(missing));
    if (stop) handle.cancel(); else f.service.decideApproval(mutationDecision(a, 'reject'));
    const result = await handle.done; assert.equal(result.toolCalls![0]!.status, stop ? 'cancelled' : 'rejected');
    await assert.rejects(access(join(f.root, 'new.txt'))); assert.deepEqual(await readdir(f.root), ['note.txt']);
  }
});
test('file changes after preview and directory revocation reject approved plans as no-effect failures', async t => {
  for (const revoke of [false, true]) {
    let turn = 0; const f = await mutationFixture(t, response => {
      if (++turn === 1) toolReply(response, [{ id: 'r', name: 'read', args: { path: 'note.txt' } }]);
      else if (turn === 2) toolReply(response, [{ id: 'e', name: 'edit', args: { path: 'note.txt', edits: [{ oldText: 'alpha', newText: 'changed' }] } }]); else answer(response);
    });
    const handle = f.send(); const a = await f.approval();
    if (revoke) f.service.fileScopes.revoke(f.sessionId, f.grant.grantId); else await writeFile(join(f.root, 'note.txt'), 'external');
    f.service.decideApproval(mutationDecision(a)); const result = await handle.done;
    assert.equal(result.toolCalls![1]!.status, 'failed'); assert.notEqual(result.toolCalls![1]!.status, 'outcome_unknown');
    assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), revoke ? 'alpha\nbeta\n' : 'external');
  }
});

test('out-of-range, linked, missing-parent and oversized previews fail before any file approval', async t => {
  for (const [path, content] of [['../escaped.txt', 'x'], ['missing/new.txt', 'x'], ['large.txt', 'x'.repeat(150_000)], ['linked.txt', 'x']] as const) {
    let turn = 0; const f = await mutationFixture(t, response => ++turn === 1
      ? toolReply(response, [{ id: 'w', name: 'write', args: { path, content } }]) : answer(response));
    if (path === 'linked.txt') { await writeFile(join(f.directory, 'outside.txt'), 'outside'); await symlink(join(f.directory, 'outside.txt'), join(f.root, path)); }
    const result = await f.send().done; assert.equal(result.toolCalls![0]!.status, 'rejected'); assert.deepEqual(result.approvals, []);
    assert.deepEqual((await readdir(f.root)).sort(), path === 'linked.txt' ? ['linked.txt', 'note.txt'] : ['note.txt']);
  }
});
test('partial reads and ambiguous Pi edits cannot produce an overwrite or edit authorization', async t => {
  for (const partial of [true, false]) {
    let turn = 0; const f = await mutationFixture(t, response => {
      if (++turn === 1) toolReply(response, [{ id: 'r', name: 'read', args: { path: 'note.txt', ...(partial ? { limit: 1 } : {}) } }]);
      else if (turn === 2) toolReply(response, [{ id: 'm', name: partial ? 'write' : 'edit', args: partial
        ? { path: 'note.txt', content: 'rewrite' } : { path: 'note.txt', edits: [{ oldText: 'alpha', newText: 'edited' }] } }]); else answer(response);
    });
    await writeFile(join(f.root, 'note.txt'), 'alpha\nalpha\n'); const result = await f.send().done;
    assert.equal(result.toolCalls![1]!.status, 'rejected'); assert.deepEqual(result.approvals, []);
    assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), 'alpha\nalpha\n');
  }
});
