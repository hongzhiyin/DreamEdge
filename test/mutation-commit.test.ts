import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, link, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mutationFixture, mutationDecision } from './helpers/mutation-loop.js';
import { toolReply } from './helpers/tool-loop.js';
import { beginSse, chatChunk } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';
const answer = (response: Parameters<typeof beginSse>[0]) => { beginSse(response); chatChunk(response, { role: 'assistant', content: 'done' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n'); };
const newFile = (response: Parameters<typeof beginSse>[0]) => toolReply(response, [{ id: 'w', name: 'write', args: { path: 'new.txt', content: 'new' } }]);

test('DSH no-replace publication preserves a concurrent creator even after the final preview check', async t => {
  let turn = 0;
  const f = await mutationFixture(t, r => ++turn === 1 ? newFile(r) : answer(r), { configureBackend: backend => {
    backend.internals.linkFile = async (temp, target) => { await writeFile(target, 'external', { flag: 'wx' }); await link(temp, target); };
  } });
  const handle = f.send(); f.service.decideApproval(mutationDecision(await f.approval())); const result = await handle.done;
  assert.equal(result.toolCalls![0]!.status, 'failed'); assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'external');
  assert.deepEqual((await readdir(f.root)).sort(), ['new.txt', 'note.txt']);
});
test('a failure after staging rechecks the current version and leaves the external content intact', async t => {
  let turn = 0;
  const f = await mutationFixture(t, response => {
    if (++turn === 1) toolReply(response, [{ id: 'r', name: 'read', args: { path: 'note.txt' } }]);
    else if (turn === 2) toolReply(response, [{ id: 'e', name: 'edit', args: { path: 'note.txt', edits: [{ oldText: 'alpha', newText: 'edited' }] } }]); else answer(response);
  }, { beforePublish: async () => { await writeFile(join(f.root, 'note.txt'), 'external'); } });
  const handle = f.send(); f.service.decideApproval(mutationDecision(await f.approval())); const result = await handle.done;
  assert.equal(result.toolCalls![1]!.status, 'failed'); assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), 'external');
  assert.deepEqual(await readdir(f.root), ['note.txt']);
});
test('stopping before publication waits for retained file ownership; a second session cannot publish early', async t => {
  let unblock!: () => void; const barrier = new Promise<void>(r => { unblock = r; }); let staged = false; let publications = 0;
  t.after(() => unblock());
  const f = await mutationFixture(t, (response, request) => {
    const messages = request.body.messages as { role: string; content: string }[];
    if (messages.at(-1)?.role === 'user') newFile(response); else answer(response);
  }, { beforePublish: async () => { if (!staged) { staged = true; await barrier; } }, afterCommit: async () => { publications++; } });
  const other = f.service.createSession({ connectionId: f.config.id }).sessionId;
  await f.service.fileScopes.chooseDirectory(other, { mode: 'read-write', remember: true });
  const first = f.send(); f.service.decideApproval(mutationDecision(await f.approval())); await waitUntil(() => staged);
  first.cancel(); const second = f.send('two', other); f.service.decideApproval(mutationDecision(await f.approval(other)));
  let finished = false; void second.done.then(() => { finished = true; }); await delay(30); assert.equal(finished, false);
  unblock(); assert.equal((await first.done).toolCalls![0]!.status, 'cancelled');
  assert.equal((await second.done).toolCalls![0]!.status, 'succeeded'); assert.equal(publications, 1);
});
test('stopping after native commit retains a known success instead of falsely reporting an unknown effect', async t => {
  let turn = 0; let stop: (() => void) | undefined;
  const f = await mutationFixture(t, r => ++turn === 1 ? newFile(r) : answer(r), { afterCommit: async () => { stop!(); } });
  const handle = f.send(); stop = () => handle.cancel(); f.service.decideApproval(mutationDecision(await f.approval()));
  const result = await handle.done; assert.equal(result.status, 'cancelled'); assert.equal(result.toolCalls![0]!.status, 'succeeded');
  assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'new'); assert.equal(f.server.requests.length, 1);
  assert.deepEqual(f.store.load()[0]!.runs[0]!.toolCalls, result.toolCalls);
});
test('an unclassified post-commit fault is unknown, preserves the real file and prohibits automatic retry', async t => {
  const f = await mutationFixture(t, newFile, { afterCommit: async () => { throw new Error('fixture post-commit fault'); } });
  const handle = f.send(); f.service.decideApproval(mutationDecision(await f.approval())); const result = await handle.done;
  assert.equal(result.status, 'failed'); assert.equal(result.toolCalls![0]!.status, 'outcome_unknown');
  assert.equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'new');
  assert.throws(() => f.service.retry(f.sessionId, result.runId), { code: 'RETRY_UNAVAILABLE' });
});
test('expired approval never consumes a filesystem publication', async t => {
  let turn = 0; const f = await mutationFixture(t, r => ++turn === 1 ? newFile(r) : answer(r), {}, 60);
  const handle = f.send(); const a = await f.approval(); await delay(80); const result = await handle.done;
  assert.equal(result.approvals![0]!.status, 'expired'); assert.equal(result.toolCalls![0]!.status, 'rejected');
  assert.throws(() => f.service.decideApproval(mutationDecision(a))); assert.deepEqual(await readdir(f.root), ['note.txt']);
});
