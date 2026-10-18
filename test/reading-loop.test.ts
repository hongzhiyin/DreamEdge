import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '../src/index.js';
import { ReaderService } from '../src/reading/service.js';
import { ReaderStore } from '../src/reading/store.js';
import { readingTools } from '../src/reading/tools.js';
import { FixtureReader } from './helpers/reader.js';
import { toolLoopFixture, toolReply } from './helpers/tool-loop.js';
import { chatReply, deadline } from './helpers/server.js';
import { waitUntil } from './helpers/storage.js';
import type { JsonObject } from '@earendil-works/pi-ai';

async function fixture(t: Parameters<typeof toolLoopFixture>[0], calls: { id: string; name: string; args: JsonObject }[]) {
  const registry = new ToolRegistry(); let turn = 0;
  const f = await toolLoopFixture(t, response => {
    const call = calls[turn++]; if (call) toolReply(response, [call]); else chatReply(response);
  }, registry);
  const client = new FixtureReader(), store = new ReaderStore();
  const reader = new ReaderService(client, store, id => f.service.getSnapshot(id), () => f.config);
  for (const tool of readingTools(reader)) registry.register(tool);
  await reader.ui({ type: 'bind', chatId: f.sessionId, readerSessionId: 'window', bookId: 'book' });
  return { ...f, client, reader, readerStore: store };
}

test('Pi executes bound reads, navigation and verified quotes with committed host receipts', async t => {
  const f = await fixture(t, [
    { id: 'page', name: 'reader_page', args: { page: 96 } },
    { id: 'nav', name: 'reader_navigate', args: { page: 97 } },
    { id: 'quote', name: 'reader_quote', args: { page: 96, text: 'unique original passage' } },
    { id: 'locate', name: 'reader_locate', args: { citationId: 'citation' } },
    { id: 'return', name: 'reader_return', args: {} },
  ]);
  const result = await deadline(f.send().done, 10000);
  assert.deepEqual(result.toolCalls?.map(c => c.status), Array(5).fill('succeeded'));
  assert.equal(result.approvals?.length, 4);
  const quote = f.client.calls.find(c => c.operation === 'citation.create')!;
  assert.equal(quote.input.contextVersion, 'v1');
  assert.deepEqual((quote.input.params.source as JsonObject).anchor,
    { version: 1, start: 2, end: 25, prefix: 'A ', suffix: '. Another sentence.' });
  assert.equal(f.readerStore.requests(f.sessionId, 'book').every(r => r.status === 'complete'), true);
  assert.equal(f.readerStore.requests(f.sessionId, 'book').length, 4);
  assert.throws(() => f.reader.guardHistory(f.sessionId, { ...f.config, model: 'changed' }), { code: 'INVALID_CONTEXT' });
});

test('note creation waits for explicit approval and authorizes only the created note', async t => {
  const f = await fixture(t, [{ id: 'create', name: 'reader_note_create', args: { kind: 'page', page: 96, title: 'Test', userContent: 'Notes' } },
    { id: 'get', name: 'reader_note_get', args: { noteId: 'note' } }]);
  const handle = f.send();
  await waitUntil(() => f.service.getSnapshot(f.sessionId).runs[0]?.approvals?.some(a => a.status === 'pending') === true);
  assert.equal(f.client.calls.some(c => c.operation === 'notes.create'), false);
  const approval = f.service.getSnapshot(f.sessionId).runs[0]!.approvals![0]!;
  assert.equal(handle.decideApproval!({ ...approval, decision: 'approve' }), true);
  const result = await deadline(handle.done, 5000);
  assert.deepEqual(result.toolCalls?.map(c => c.status), ['succeeded', 'succeeded']);
  assert.equal(f.reader.allowedNote(f.sessionId, f.reader.binding(f.sessionId), 'other'), false);
});

test('uncertain write queries original request without duplicate creation; unresolved state blocks new writes', async t => {
  const f = await fixture(t, [{ id: 'nav1', name: 'reader_navigate', args: { page: 2 } },
    { id: 'nav2', name: 'reader_navigate', args: { page: 3 } }]);
  f.client.respond = op => op === 'reader.navigate' ? { ok: false, error: { code: 'TIMEOUT', message: 'unknown' } } : undefined;
  await deadline(f.send().done, 5000);
  const writes = f.client.calls.filter(c => c.operation === 'reader.navigate');
  assert.equal(writes.length, 1);
  assert.equal(f.client.calls.find(c => c.operation === 'requests.get')!.input.params.targetRequestId, writes[0]!.input.requestId);
  assert.equal(f.readerStore.requests(f.sessionId, 'book')[0]?.status, 'uncertain');
});

test('timeout reconciled as committed does not replay the action', async t => {
  const f = await fixture(t, [{ id: 'nav', name: 'reader_navigate', args: { page: 2 } }]);
  f.client.respond = op => op === 'reader.navigate' ? { ok: false, error: { code: 'TIMEOUT', message: 'unknown' } }
    : op === 'requests.get' ? { ok: true, data: { status: 'complete', result: { ok: true, data: { page: 2 } } } } : undefined;
  const result = await deadline(f.send().done, 5000);
  assert.equal(result.toolCalls![0]!.status, 'succeeded');
  assert.equal(f.client.calls.filter(c => c.operation === 'reader.navigate').length, 1);
});

test('note revision conflict is returned without overwriting or retrying', async t => {
  const f = await fixture(t, [{ id: 'edit', name: 'reader_note_update', args: { noteId: 'note', expectedRevision: 1, title: 'New', userContent: 'Changed' } }]);
  await f.reader.ui({ type: 'selectNote', chatId: f.sessionId, noteId: 'note' });
  f.client.respond = op => op === 'notes.update' ? { ok: false, error: { code: 'VERSION_CONFLICT', message: 'changed' } } : undefined;
  const handle = f.send();
  await waitUntil(() => f.service.getSnapshot(f.sessionId).runs[0]?.approvals?.some(a => a.status === 'pending') === true);
  handle.decideApproval!({ ...f.service.getSnapshot(f.sessionId).runs[0]!.approvals![0]!, decision: 'approve' });
  const result = await deadline(handle.done, 5000);
  assert.equal(result.toolCalls![0]!.status, 'failed');
  assert.equal(f.client.calls.filter(c => c.operation === 'notes.update').length, 1);
  assert.equal(f.client.calls.some(c => c.operation === 'requests.get'), false);
});

test('stop while awaiting note approval never dispatches a note write', async t => {
  const f = await fixture(t, [{ id: 'create', name: 'reader_note_create', args: { kind: 'page', page: 96, title: 'Test', userContent: '' } }]);
  const handle = f.send();
  await waitUntil(() => f.service.getSnapshot(f.sessionId).runs[0]?.approvals?.some(a => a.status === 'pending') === true);
  await assert.rejects(f.reader.ui({ type: 'unbind', chatId: f.sessionId }), /停止/);
  handle.cancel(); assert.equal((await deadline(handle.done, 5000)).status, 'cancelled');
  assert.equal(f.client.calls.some(c => c.operation === 'notes.create'), false);
});
