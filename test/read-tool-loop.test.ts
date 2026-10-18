import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, access, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { readLoopFixture } from './helpers/read-loop.js';
import { toolReply } from './helpers/tool-loop.js';
import { beginSse, chatChunk } from './helpers/server.js';
const answer = (response: Parameters<typeof beginSse>[0], text = 'file answer') => {
  beginSse(response); chatChunk(response, { role: 'assistant', content: text }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
};

test('real Pi loop exposes reads only after authorization, commits provenance and retains native results on follow-up', async t => {
  let turn = 0;
  const f = await readLoopFixture(t, (response, request) => {
    if ((request.body.messages as { content: string }[]).at(-1)?.content === 'text') { answer(response); return; }
    if (++turn === 1) toolReply(response, [{ id: 'read-1', name: 'read', args: { path: 'note.txt' } }]); else answer(response);
  });
  const initial = await f.send('text').done; assert.equal(initial.status, 'completed');
  assert.equal(initial.toolsSnapshot?.some(tool => tool.name === 'read'), false);
  await f.grant(); turn = 0;
  const result = await f.send('read').done;
  assert.equal(result.status, 'completed'); assert.equal(result.toolCalls![0]!.status, 'succeeded');
  const call = result.toolCalls![0]!; if (call.status === 'succeeded') assert.match(JSON.stringify(call.result), /remembered file secret/);
  const next = await f.send('followup').done; assert.equal(next.status, 'completed');
  const request = f.server.requests.at(-1)!.body;
  assert.match(JSON.stringify(request.messages), /remembered file secret/);
  assert.deepEqual(f.store.load()[0]!.runs.at(-2)!.toolCalls, result.toolCalls);
});
test('all four tools share the existing Pi execution loop and preserve bounded results', async t => {
  let turn = 0;
  const f = await readLoopFixture(t, response => {
    if (++turn === 1) toolReply(response, [
      { id: 'ls', name: 'ls', args: {} }, { id: 'find', name: 'find', args: { pattern: '*.txt' } },
      { id: 'grep', name: 'grep', args: { pattern: 'needle' } }, { id: 'read', name: 'read', args: { path: 'note.txt' } },
    ]); else answer(response);
  });
  await f.grant(); const result = await f.send().done;
  assert.equal(result.status, 'completed'); assert.deepEqual(result.toolCalls!.map(call => call.status), Array(4).fill('succeeded'));
  assert.equal(f.server.requests.length, 2);
});
test('model destination change blocks both next provider request and new question before file data is sent', async t => {
  const f = await readLoopFixture(t, response => toolReply(response, [{ id: 'read', name: 'read', args: { path: 'note.txt' } }]));
  await f.grant(); const record = f.service.fileScopes.recordObservations.bind(f.service.fileScopes);
  f.service.fileScopes.recordObservations = values => { record(values); f.config.model = 'other-model'; };
  const result = await f.send().done;
  assert.equal(result.status, 'failed'); assert.equal(result.error?.code, 'INVALID_CONTEXT');
  assert.equal(f.server.requests.length, 1);
  const count = f.service.getSnapshot(f.sessionId).messages.length;
  assert.throws(() => f.send('new'), { code: 'FILE_CONTEXT_DESTINATION' });
  assert.equal(f.service.getSnapshot(f.sessionId).messages.length, count);
});
test('revocation preserves historical file results for the original destination but denies fresh file reads', async t => {
  let turn = 0; const f = await readLoopFixture(t, response => {
    if (++turn === 1) toolReply(response, [{ id: 'read', name: 'read', args: { path: 'note.txt' } }]); else answer(response);
  });
  const grant = (await f.grant())!; assert.equal((await f.send().done).status, 'completed');
  f.service.fileScopes.revoke(f.sessionId, grant.grantId);
  const next = await f.send('followup').done; assert.equal(next.status, 'completed');
  assert.equal(next.toolsSnapshot?.some(tool => tool.name === 'read'), false);
  assert.match(JSON.stringify(f.server.requests.at(-1)!.body.messages), /remembered file secret/);
});

test('stored file provenance must match the native result and owning directory grant', async t => {
  let turn = 0; const f = await readLoopFixture(t, response => {
    if (++turn === 1) toolReply(response, [{ id: 'read', name: 'read', args: { path: 'note.txt' } }]); else answer(response);
  });
  await f.grant(); assert.equal((await f.send().done).status, 'completed');
  const original = f.store.load()[0]!;
  for (const replacement of ['missing-grant', 'missing-proof']) {
    const broken = structuredClone(original); broken.session.version++;
    const call = broken.runs[0]!.toolCalls![0]!;
    if (call.status !== 'succeeded') throw new Error('fixture');
    const details = call.result.details as import('@earendil-works/pi-ai').JsonObject;
    if (replacement === 'missing-proof') delete details.fileAccess;
    else (details.fileAccess as import('@earendil-works/pi-ai').JsonObject).grantId = replacement;
    for (const entry of broken.runs[0]!.transcript!) if (entry.message.role === 'toolResult') entry.message.details = details;
    assert.throws(() => f.store.save(broken, original.session.version), { code: 'INVALID_DATA' });
  }
  assert.deepEqual(f.store.load()[0], original);
});

test('stopping an executing file tool waits for worker cleanup and never sends its result to the next model turn', async t => {
  const f = await readLoopFixture(t, response => toolReply(response, [{ id: 'search', name: 'grep', args: { pattern: 'needle' } }]));
  await writeFile(join(f.root, 'more.txt'), 'needle\n'.repeat(10000)); await f.grant();
  const handle = f.send(); const deadline = Date.now() + 3000;
  while (!(await readdir(f.cacheRoot)).length) { assert.ok(Date.now() < deadline); await delay(1); }
  handle.cancel(); const result = await handle.done;
  assert.equal(result.status, 'cancelled'); assert.equal(f.server.requests.length, 1);
  assert.deepEqual(await readdir(f.cacheRoot), []);
  assert.equal(result.toolCalls!.some(call => call.status === 'succeeded'), false);
});
