import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { operationFixture } from './helpers/file-operations.js';
import { mutationFixture, mutationDecision } from './helpers/mutation-loop.js';
import { toolReply } from './helpers/tool-loop.js';
import { beginSse, chatChunk, deadline } from './helpers/server.js';
import { fileOperationTools } from '../src/files/operation-tools.js';
import { batchReference, reopenBatch } from './helpers/file-batch.js';
import type { ConversationHandle } from '../src/conversation/types.js';
const answer = (response: Parameters<typeof beginSse>[0]) => {
  beginSse(response); chatChunk(response, { role: 'assistant', content: 'done' }); chatChunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
};

test('sealed host catalog rejects late tool injection and unknown shell, MCP or code execution calls', async t => {
  let turn = 0; const f = await operationFixture(t, response => ++turn === 1 ? toolReply(response,
    ['bash', 'powershell', 'codemode', 'mcp__fs__remove', 'execute_code'].map((name, i) => ({ id: `x${i}`, name, args: { command: 'remove files' } }))) : answer(response));
  f.registry.seal(); assert.throws(() => f.registry.register({ name: 'late', version: '1', label: 'late', description: 'unreviewed',
    parameters: Type.Object({}, { additionalProperties: false }), effect: 'read', approval: 'never', resources: [], timeoutMs: 1000,
    execute: async () => { throw new Error('must never execute'); } }));
  const result = await f.send().done; assert.ok(result.toolCalls!.every(c => c.status === 'rejected' && c.error.code === 'UNKNOWN_TOOL'));
  assert.equal(f.trashed(), 0); await access(join(f.root, 'note.txt'));
});

test('direct invocation cannot bypass prepared plans or approval, and unexpected operation arguments are rejected', async t => {
  let turn = 0; const f = await operationFixture(t, response => ++turn === 1 ? toolReply(response, [{ id: 'bad', name: 'delete',
    args: { path: 'note.txt', command: 'bypass approvals' } }]) : answer(response));
  const tool = f.registry.resolve(f.registry.snapshots(['delete'])[0]!);
  await assert.rejects(tool.execute({ path: 'note.txt' }, { sessionId: f.sessionId, runId: 'invented', turnId: 'fake', toolCallId: 'fake', signal: new AbortController().signal }));
  const result = await f.send().done; assert.equal(result.toolCalls![0]!.status, 'rejected'); assert.equal(result.approvals!.length, 0);
  assert.equal(f.trashed(), 0); await access(join(f.root, 'note.txt'));
});

test('host-protected application data remain readable but cannot be mutated by any managed file tool', async t => {
  let turn = 0; const f = await mutationFixture(t, response => ++turn === 1 ? toolReply(response, [
    { id: 'r', name: 'read', args: { path: 'note.txt' } },
    { id: 'w', name: 'write', args: { path: 'new.txt', content: 'not allowed' } },
    { id: 'd', name: 'delete', args: { path: 'note.txt', permanent: true } },
  ]) : answer(response), {}, 120_000, { account: true, protectRoot: true });
  for (const tool of fileOperationTools(f.service.fileScopes, { trash: async () => { throw new Error('unexpected'); } })) f.registry.register(tool);
  const result = await f.send().done; assert.equal(result.toolCalls![0]!.status, 'succeeded');
  assert.ok(result.toolCalls!.slice(1).every(c => c.status === 'rejected')); await access(join(f.root, 'note.txt')); await assert.rejects(access(join(f.root, 'new.txt')));
});

test('stopped deletion batch resumes only undeleted members after restart and fresh confirmation', async t => {
  let turn = 0; let handle!: ConversationHandle;
  const f = await operationFixture(t, response => {
    ++turn;
    if (turn === 1) toolReply(response, [{ id: 'a', name: 'delete', args: { path: 'note.txt', permanent: true } }, { id: 'b', name: 'delete', args: { path: 'second.txt', permanent: true } }]);
    else if (turn === 2) toolReply(response, [{ id: 'retry-b', name: 'delete', args: { path: 'second.txt', permanent: true } }]);
    else answer(response);
  }, { afterCommit: async () => handle.cancel() });
  await writeFile(join(f.root, 'second.txt'), 'second'); handle = f.send(); const first = await f.approval();
  f.service.decideApproval(mutationDecision(first)); const stopped = await handle.done;
  assert.equal(stopped.toolCalls![0]!.status, 'succeeded'); await access(join(f.root, 'second.txt'));
  const restored = await reopenBatch(t, f);
  for (const tool of fileOperationTools(restored.service.fileScopes, { trash: async () => { throw new Error('unexpected trash'); } })) restored.registry.register(tool);
  const resumed = restored.service.resumeBatch(batchReference(first)); const approval = await restored.approval();
  assert.equal(approval.batchPlan!.members.length, 1); assert.match(approval.batchPlan!.members[0]!.path, /second.txt$/);
  restored.service.decideApproval(mutationDecision(approval)); assert.equal((await deadline(resumed.done, 10_000)).status, 'completed');
  await assert.rejects(access(join(f.root, 'second.txt'))); assert.throws(() => restored.service.resumeBatch(batchReference(first)), /没有需要恢复/);
});

test('a directory operation cannot hide sensitive startup files from the execution policy', async t => {
  let turn = 0; const f = await operationFixture(t, response => ++turn === 1 ? toolReply(response,
    [{ id: 'copy', name: 'copy', args: { path: 'configuration', destination: 'copy' } }]) : answer(response));
  const { mkdir } = await import('node:fs/promises'); await mkdir(join(f.root, 'configuration'));
  await writeFile(join(f.root, 'configuration/.zshrc'), 'fixture startup');
  const handle = f.send(); const receipt = await f.approval(); assert.equal(receipt.inspection!.decision, 'ask');
  assert.match(receipt.inspection!.rule, /configuration$/); await assert.rejects(access(join(f.root, 'copy')));
  f.service.decideApproval(mutationDecision(receipt, 'reject')); await handle.done;
});
