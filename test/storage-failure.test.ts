import assert from 'node:assert/strict';
import test from 'node:test';
import { startPending } from './helpers/conversation.js';
import { storageFixture, waitUntil } from './helpers/storage.js';

test('submission transaction rolls back every row and save retry resumes the unsent request exactly once', async t => {
  const f = await storageFixture(t);
  const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  const version = f.store.load()[0]!.session.version;
  f.fail('runs', 'INSERT');
  const input = { sessionId, clientMessageId: 'one', text: 'question' };
  const handle = f.service.send(input);
  await startPending();
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.getSnapshot(sessionId).saveState.status, 'failed');
  const unchanged = f.store.load()[0]!;
  assert.equal(unchanged.session.version, version);
  assert.equal(unchanged.messages.length, 0); assert.equal(unchanged.runs.length, 0);
  assert.equal(f.service.send(input), handle);
  assert.throws(() => f.service.send({ ...input, clientMessageId: 'two' }), { code: 'SESSION_BUSY' });
  assert.equal(f.service.retrySave(sessionId).status, 'failed');
  assert.ok(!JSON.stringify(f.service.getSnapshot(sessionId)).includes('private disk failure'));
  f.clearFailure();
  assert.equal(f.service.retrySave(sessionId).status, 'saved');
  await startPending(); assert.equal(f.calls.length, 1);
  f.calls[0]!.finish(); await handle.done;
  assert.equal(f.store.load()[0]!.messages.length, 1);
  assert.equal(f.store.load()[0]!.runs.length, 1);
});

test('a request waiting for save can be cancelled without dispatching after a later save retry', async t => {
  const f = await storageFixture(t);
  const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  f.fail('runs', 'INSERT');
  const handle = f.service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending(); handle.cancel();
  assert.equal((await handle.done).status, 'cancelled');
  f.clearFailure(); f.service.retrySave(sessionId);
  await startPending(); assert.equal(f.calls.length, 0);
  assert.equal(f.store.load()[0]!.runs[0]!.status, 'cancelled');
  const retry = f.service.retry(sessionId);
  await startPending(); f.calls[0]!.finish(); await retry.done;
});

test('final save failure retains a completed answer, blocks the next turn and permits save-only retry', async t => {
  const f = await storageFixture(t);
  const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  const handle = f.service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending();
  f.fail('runs', 'UPDATE', "NEW.status = 'completed'");
  f.calls[0]!.finish('completed', 'complete answer');
  assert.equal((await handle.done).status, 'completed');
  const snapshot = f.service.getSnapshot(sessionId);
  assert.equal(snapshot.saveState.status, 'failed');
  assert.equal(snapshot.runs[0]!.text, 'complete answer');
  assert.equal(f.store.load()[0]!.runs[0]!.status, 'running');
  assert.throws(() => f.service.send({ sessionId, clientMessageId: 'two', text: 'next' }), { code: 'SAVE_FAILED' });
  f.clearFailure();
  assert.equal(f.service.retrySave(sessionId).status, 'saved');
  assert.equal(f.calls.length, 1, 'Saving must not call the model again');
  assert.equal(f.store.load()[0]!.runs[0]!.nativeMessage?.stopReason, 'stop');
  const next = f.service.send({ sessionId, clientMessageId: 'two', text: 'next' });
  await startPending();
  assert.ok(JSON.stringify(f.calls[1]!.request.messages).includes('complete answer'));
  f.calls[1]!.finish(); await next.done;
});

test('checkpoint failure leaves generation intact and requires explicit saving of the latest result', async t => {
  const f = await storageFixture(t);
  const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  const handle = f.service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending(); f.fail('runs', 'UPDATE');
  await f.calls[0]!.emit(1, 'Partial');
  await waitUntil(() => f.service.getSnapshot(sessionId).saveState.status === 'failed');
  assert.equal(f.store.load()[0]!.runs[0]!.text, '');
  f.clearFailure();
  await f.calls[0]!.emit(2, ' content');
  f.calls[0]!.finish('completed', 'Partial content'); await handle.done;
  assert.equal(f.service.getSnapshot(sessionId).saveState.status, 'failed');
  assert.equal(f.service.getSnapshot(sessionId).runs[0]!.text, 'Partial content');
  f.service.retrySave(sessionId);
  assert.equal(f.store.load()[0]!.runs[0]!.text, 'Partial content');
});

test('session creation failure retains the session and blocks sends until saving succeeds', async t => {
  const f = await storageFixture(t);
  f.fail('sessions', 'INSERT');
  const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  assert.equal(f.store.load().length, 0);
  assert.equal(f.service.getSnapshot(sessionId).saveState.status, 'failed');
  assert.throws(() => f.service.send({ sessionId, clientMessageId: 'one', text: 'question' }), { code: 'SAVE_FAILED' });
  f.clearFailure(); f.service.retrySave(sessionId);
  const handle = f.service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending(); f.calls[0]!.finish(); await handle.done;
});

test('shutdown cannot report success with unsaved results; save retry permits a second close', async t => {
  const f = await storageFixture(t);
  const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  const handle = f.service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending(); f.fail('runs', 'UPDATE');
  f.calls[0]!.finish(); await handle.done;
  await assert.rejects(f.service.dispose(), { code: 'SAVE_FAILED' });
  assert.equal(f.store.load()[0]!.runs[0]!.status, 'running');
  f.clearFailure(); f.service.retrySave(sessionId);
  await f.service.dispose();
  const reopened = f.open();
  assert.equal(reopened.service.getSnapshot(sessionId).runs[0]!.status, 'completed');
});
