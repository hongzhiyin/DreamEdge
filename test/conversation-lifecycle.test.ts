import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationService } from '../src/index.js';
import { assistant, conversationFixture, startPending } from './helpers/conversation.js';
import { connection } from './helpers/server.js';

test('duplicate submissions return the original attempt; conflicts and concurrent sends are rejected', async () => {
  const { service, calls, create } = conversationFixture();
  const sessionId = create();
  const command = { sessionId, clientMessageId: 'one', text: 'question' };
  const first = service.send(command);
  assert.equal(service.send(command), first);
  assert.throws(() => service.send({ ...command, text: 'different' }), { code: 'MESSAGE_CONFLICT' });
  assert.throws(() => service.send({ ...command, thinkingLevel: 'low' }), { code: 'MESSAGE_CONFLICT' });
  assert.throws(() => service.send({ ...command, clientMessageId: 'two' }), { code: 'SESSION_BUSY' });
  assert.throws(() => service.retry(sessionId), { code: 'SESSION_BUSY' });
  await startPending(); assert.equal(calls.length, 1);
  calls[0]!.finish('failed'); await first.done;
  assert.equal(service.send(command), first, 'A duplicate is not an implicit retry');
  assert.equal(service.getSnapshot(sessionId).messages.length, 1);
});

test('stop forwards cancel once and keeps the session locked until done, not until settled event', async () => {
  const { service, calls, create } = conversationFixture();
  const sessionId = create();
  const handle = service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending(); await calls[0]!.emit(1, 'partial');
  service.stop(sessionId); handle.cancel();
  assert.equal(calls[0]!.cancelCount, 1);
  assert.equal(service.getSnapshot(sessionId).runs[0]!.status, 'cancelling');
  await calls[0]!.emit(2, 'ignored after stop'); await calls[0]!.settled(3);
  assert.equal(service.getSnapshot(sessionId).runs[0]!.text, 'partial');
  assert.throws(() => service.send({ sessionId, clientMessageId: 'two', text: 'next' }), { code: 'SESSION_BUSY' });
  calls[0]!.finish('cancelled', 'partial');
  const final = await handle.done;
  assert.equal(final.status, 'cancelled'); assert.equal(final.text, 'partial');
  assert.equal(service.getSnapshot(sessionId).activeRunId, undefined);
  const retry = service.retry(sessionId);
  await startPending();
  assert.equal(retry.userMessageId, handle.userMessageId);
  calls[1]!.finish(); await retry.done;
});

test('wrong identity, duplicate and late events cannot change current content or completed runs', async () => {
  const { service, calls, create } = conversationFixture();
  const sessionId = create();
  const first = service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending();
  await calls[0]!.emit(1, 'a'); await calls[0]!.emit(1, 'duplicate');
  await calls[0]!.emit(0, 'out of order');
  await calls[0]!.emit(2, 'wrong run', { runId: 'wrong' });
  await calls[0]!.emit(2, 'wrong session', { sessionId: 'wrong' });
  await calls[0]!.emit(2, 'b');
  assert.equal(service.getSnapshot(sessionId).runs[0]!.text, 'ab');
  calls[0]!.finish('completed', 'ab'); await first.done;
  const second = service.send({ sessionId, clientMessageId: 'two', text: 'next' });
  await startPending();
  const version = service.getSnapshot(sessionId).session.version;
  await calls[0]!.emit(100, 'late');
  assert.equal(service.getSnapshot(sessionId).session.version, version);
  await calls[1]!.emit(1, 'fresh');
  assert.deepEqual(service.getSnapshot(sessionId).runs.map(run => run.text), ['ab', 'fresh']);
  calls[1]!.finish(); await second.done;
});

test('immediate cancel avoids model dispatch and still records a cancelled attempt', async () => {
  const { service, calls, create } = conversationFixture();
  const sessionId = create();
  const handle = service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  handle.cancel();
  assert.equal((await handle.done).status, 'cancelled');
  assert.equal(calls.length, 0);
  assert.equal(service.getSnapshot(sessionId).runs.length, 1);
});

test('dispose cancels every active session, awaits settlement and prevents new operations', async () => {
  const { service, calls, create } = conversationFixture();
  const sessions = [create(), create()];
  for (const sessionId of sessions) service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending();
  const closing = service.dispose();
  assert.equal(service.dispose(), closing);
  assert.deepEqual(calls.map(call => call.cancelCount), [1, 1]);
  assert.throws(() => service.createSession({ connectionId: 'fixture' }), { code: 'SERVICE_CLOSED' });
  let closed = false; void closing.then(() => { closed = true; });
  await startPending(); assert.equal(closed, false);
  for (const call of calls) call.finish('cancelled');
  await closing;
  assert.ok(sessions.every(id => service.getSnapshot(id).activeRunId === undefined));
});

test('runtime initialization failure settles safely and permits manual retry', async () => {
  let failure = true;
  const service = new ConversationService({ connection: () => connection('http://127.0.0.1:1'), runtime: () => {
    if (failure) throw new Error('private provider detail');
    return { start: request => ({ cancel() {}, done: Promise.resolve({ ...request,
      status: 'completed' as const, text: 'answer', message: assistant('answer'), stopReason: 'stop' }) }) };
  } });
  const sessionId = service.createSession({ connectionId: 'fixture' }).sessionId;
  const first = await service.send({ sessionId, clientMessageId: 'one', text: 'question' }).done;
  assert.equal(first.status, 'failed');
  assert.ok(!JSON.stringify(first).includes('private provider detail'));
  failure = false;
  assert.equal((await service.retry(sessionId).done).status, 'completed');
  assert.equal(service.getSnapshot(sessionId).messages.length, 1);
});

test('commands validate before mutating records and retry is limited to the latest question', async () => {
  const { service, calls, create } = conversationFixture();
  const sessionId = create();
  assert.throws(() => service.retry(sessionId), { code: 'RETRY_UNAVAILABLE' });
  assert.throws(() => service.send({ sessionId, clientMessageId: '', text: 'question' }), { code: 'INVALID_COMMAND' });
  assert.throws(() => service.send({ sessionId, clientMessageId: 'one', text: ' ' }), { code: 'INVALID_COMMAND' });
  assert.throws(() => service.getSnapshot('unknown'), { code: 'SESSION_NOT_FOUND' });
  assert.equal(service.getSnapshot(sessionId).messages.length, 0);
  const first = service.send({ sessionId, clientMessageId: 'one', text: 'failed question' });
  await startPending(); calls[0]!.finish('failed'); await first.done;
  const second = service.send({ sessionId, clientMessageId: 'two', text: 'successful question' });
  await startPending(); calls[1]!.finish(); await second.done;
  assert.throws(() => service.retry(sessionId), { code: 'RETRY_UNAVAILABLE' });
});
