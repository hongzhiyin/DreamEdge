import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationService } from '../src/index.js';
import { ChatHub } from '../src/chat/hub.js';
import { assistant, conversationFixture, startPending } from './helpers/conversation.js';
import { storageFixture } from './helpers/storage.js';
import { connection } from './helpers/server.js';

test('stale stop commands cannot cancel a newer run', async () => {
  const { service, calls, create, config } = conversationFixture();
  const hub = new ChatHub(service, config); const sessionId = create();
  const first = service.send({ sessionId, clientMessageId: 'one', text: 'first' });
  await startPending(); calls[0]!.finish(); await first.done;
  const next = service.send({ sessionId, clientMessageId: 'two', text: 'next' });
  await startPending();
  const stale = hub.execute({ type: 'stop', sessionId, runId: first.runId });
  assert.ok(!stale.ok); assert.equal(stale.error.code, 'STALE_RUN');
  first.cancel();
  assert.equal(calls[1]!.cancelCount, 0);
  assert.equal(service.getSnapshot(sessionId).activeRunId, next.runId);
  service.stop(sessionId, next.runId); calls[1]!.finish('cancelled'); await next.done;
  hub.dispose(); await service.dispose();
});

test('a delayed retry cannot retry a different latest question', async () => {
  const { service, calls, create } = conversationFixture(); const sessionId = create();
  const first = service.send({ sessionId, clientMessageId: 'one', text: 'first' });
  await startPending(); calls[0]!.finish('failed'); await first.done;
  const second = service.send({ sessionId, clientMessageId: 'two', text: 'second' });
  await startPending(); calls[1]!.finish('failed'); await second.done;
  assert.throws(() => service.retry(sessionId, first.runId), { code: 'STALE_RUN' });
  assert.equal(service.getSnapshot(sessionId).runs.length, 2);
  const retry = service.retry(sessionId, second.runId);
  await startPending(); calls[2]!.finish(); await retry.done;
  assert.equal(retry.userMessageId, second.userMessageId);
});

test('subscription callbacks observe registered duplicate commands, not half-built submissions', async () => {
  const { service, calls, create } = conversationFixture(); const sessionId = create();
  const input = { sessionId, clientMessageId: 'one', text: 'question' };
  let duplicate: ReturnType<typeof service.send> | undefined;
  let failure: unknown;
  const unsubscribe = service.subscribe(() => {
    if (duplicate || service.getSnapshot(sessionId).messages.length !== 1) return;
    try { duplicate = service.send(input); } catch (error) { failure = error; }
  });
  const handle = service.send(input); await startPending();
  assert.equal(failure, undefined); assert.equal(duplicate, handle);
  assert.equal(calls.length, 1); calls[0]!.finish(); await handle.done; unsubscribe();
});

test('completed notifications are delivered after the final durable boundary', async t => {
  const f = await storageFixture(t); const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  let observed = false; let committed = false;
  const unsubscribe = f.service.subscribe(() => {
    const snapshot = f.service.getSnapshot(sessionId);
    if (snapshot.runs[0]?.status === 'completed') {
      observed = true; committed = snapshot.saveState.savedVersion === snapshot.session.version
        && f.store.load()[0]!.runs[0]!.status === 'completed';
    }
  });
  const handle = f.service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending(); f.calls[0]!.finish(); await handle.done; await startPending();
  assert.equal(observed, true); assert.equal(committed, true); unsubscribe();
});

test('saving failure during shutdown can recover and accept new conversation commands', async t => {
  const f = await storageFixture(t); const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  const handle = f.service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending(); f.fail('runs', 'UPDATE'); f.calls[0]!.finish(); await handle.done;
  await assert.rejects(f.service.dispose(), { code: 'SAVE_FAILED' });
  assert.equal(f.service.getSnapshot(sessionId).acceptingCommands, true);
  assert.throws(() => f.service.send({ sessionId, clientMessageId: 'two', text: 'next' }), { code: 'SAVE_FAILED' });
  f.clearFailure(); f.service.retrySave(sessionId);
  const next = f.service.send({ sessionId, clientMessageId: 'two', text: 'next' });
  await startPending(); f.calls[1]!.finish(); await next.done;
});

test('sequence gaps terminate the stream, wait for settlement and exclude the response from history', async () => {
  const { service, calls, create } = conversationFixture(); const sessionId = create();
  const handle = service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending(); await calls[0]!.emit(1, 'partial'); await calls[0]!.emit(3, 'gap');
  assert.equal(calls[0]!.cancelCount, 1);
  assert.throws(() => service.send({ sessionId, clientMessageId: 'two', text: 'next' }), { code: 'SESSION_BUSY' });
  calls[0]!.finish('completed', 'provider finished');
  const result = await handle.done; assert.equal(result.status, 'failed');
  assert.equal(result.error?.code, 'UNEXPECTED_RESPONSE');
  const next = service.send({ sessionId, clientMessageId: 'two', text: 'next' });
  await startPending(); assert.equal(calls[1]!.request.messages.length, 1);
  calls[1]!.finish(); await next.done;
});

test('a throwing cancel adapter does not escape shutdown or leak its internal error', async () => {
  let settle!: (result: import('../src/index.js').RuntimeResult) => void;
  let request!: import('../src/index.js').RuntimeRequest;
  const service = new ConversationService({ connection: () => connection('http://127.0.0.1:1'), runtime: () => ({ start(input) {
    request = input;
    return { cancel() { throw new Error('private adapter secret'); }, done: new Promise(resolve => { settle = resolve; }) };
  } }) });
  const sessionId = service.createSession({ connectionId: 'fixture' }).sessionId;
  const handle = service.send({ sessionId, clientMessageId: 'one', text: 'question' }); await startPending();
  assert.doesNotThrow(() => handle.cancel());
  assert.throws(() => service.send({ sessionId, clientMessageId: 'two', text: 'next' }), { code: 'SESSION_BUSY' });
  settle({ sessionId, runId: request.runId, status: 'cancelled', text: 'partial', message: assistant('partial', 'aborted') });
  const result = await handle.done; assert.equal(result.status, 'failed');
  assert.ok(!JSON.stringify(result).includes('private adapter secret'));
  await service.dispose();
});
