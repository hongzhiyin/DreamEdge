import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import test from 'node:test';
import { startPending } from './helpers/conversation.js';
import { storageFixture, waitUntil } from './helpers/storage.js';
import { deadline } from './helpers/server.js';

test('SQLite restart restores complete native history, model parameters and command deduplication', async t => {
  const f = await storageFixture(t);
  const sessionId = f.service.createSession({ connectionId: 'fixture', systemPrompt: 'remember codes' }).sessionId;
  f.onStart(request => {
    const stored = f.store.load()[0]!;
    assert.equal(stored.messages.length, 1);
    assert.equal(stored.runs[0]!.runId, request.runId);
    assert.equal(stored.runs[0]!.status, 'running', 'Submission must be committed before model start');
  });
  const input = { sessionId, clientMessageId: 'one', text: 'code amber', thinkingLevel: 'low' as const };
  const first = f.service.send(input);
  await startPending(); const native = f.calls[0]!.finish('completed', 'remember amber'); await first.done;
  assert.equal(f.service.getSnapshot(sessionId).saveState.status, 'saved');
  assert.equal((await stat(f.path)).mode & (process.platform === 'win32' ? 0o600 : 0o777), 0o600);
  await f.service.dispose();
  const reopened = f.open();
  const duplicate = reopened.service.send(input);
  assert.equal(duplicate.runId, first.runId);
  assert.equal((await duplicate.done).status, 'completed');
  assert.equal(f.calls.length, 1);
  assert.throws(() => reopened.service.send({ ...input, thinkingLevel: 'high' }), { code: 'MESSAGE_CONFLICT' });
  f.onStart(() => {});
  const follow = reopened.service.send({ sessionId, clientMessageId: 'two', text: 'what code?' });
  await startPending();
  const context = f.calls[1]!.request.messages;
  assert.deepEqual(context.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.deepEqual(context[2], native.message, 'Signatures and all provider metadata survive SQLite JSON storage');
  f.calls[1]!.finish(); await follow.done;
});

test('stream checkpoints coalesce fragments and retain the latest version', async t => {
  const f = await storageFixture(t, 200);
  const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  const handle = f.service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending(); const before = f.writeCount();
  for (let i = 1; i <= 100; i++) await f.calls[0]!.emit(i, 'x');
  assert.equal(f.writeCount(), before);
  assert.equal(f.service.getSnapshot(sessionId).saveState.status, 'pending');
  await waitUntil(() => f.store.load()[0]!.runs[0]!.text.length === 100);
  assert.equal(f.writeCount(), before + 1);
  assert.equal(f.store.load()[0]!.runs[0]!.lastEventSequence, 100);
  f.calls[0]!.finish('completed', 'x'.repeat(100)); await handle.done;
  assert.equal(f.store.load()[0]!.runs[0]!.status, 'completed');
});

for (const phase of ['running', 'cancelling'] as const) {
  test(`SIGKILL recovery marks ${phase} as interrupted and never auto-resends`, async t => {
    const f = await storageFixture(t);
    await f.service.dispose();
    const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/storage-crash.js', import.meta.url)), f.path, phase],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { child.kill('SIGKILL'); });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject); child.once('exit', () => { resolve(); });
    });
    const ready = new Promise<void>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('CHECKPOINT_READY')) resolve(); });
      child.once('error', reject); child.once('exit', () => reject(new Error(stderr)));
    });
    await deadline(ready, 5000);
    child.kill('SIGKILL'); await deadline(exited);
    const recovered = f.open();
    const sessionId = recovered.service.listSessions()[0]!.sessionId;
    const snapshot = recovered.service.getSnapshot(sessionId);
    assert.deepEqual(snapshot.runs.map(run => run.status), ['completed', 'interrupted']);
    assert.equal(snapshot.runs[1]!.text, 'Partial');
    assert.equal(snapshot.runs[1]!.lastEventSequence, 1);
    assert.equal(snapshot.activeRunId, undefined);
    assert.equal(snapshot.saveState.status, 'saved');
    assert.equal(f.calls.length, 0);
    assert.equal(recovered.store.load()[0]!.runs[1]!.status, 'interrupted');
    const next = recovered.service.send({ sessionId, clientMessageId: 'next', text: 'continue' });
    await startPending();
    assert.deepEqual(f.calls[0]!.request.messages.map(message => message.role), ['user', 'assistant', 'user']);
    assert.ok(!JSON.stringify(f.calls[0]!.request.messages).includes('unfinished question'));
    assert.ok(!JSON.stringify(f.calls[0]!.request.messages).includes('Partial'));
    f.calls[0]!.finish(); await next.done;
  });
}

test('failed then retried attempts survive restart without duplicating the user message', async t => {
  const f = await storageFixture(t);
  const sessionId = f.service.createSession({ connectionId: 'fixture' }).sessionId;
  const failed = f.service.send({ sessionId, clientMessageId: 'one', text: 'question' });
  await startPending(); f.calls[0]!.finish('failed', 'failed partial'); await failed.done;
  await f.service.dispose();
  const reopened = f.open();
  const retry = reopened.service.retry(sessionId);
  await startPending();
  assert.equal(retry.userMessageId, failed.userMessageId);
  assert.notEqual(retry.runId, failed.runId);
  assert.equal(f.calls[1]!.request.messages.length, 1);
  f.calls[1]!.finish(); await retry.done;
  assert.equal(reopened.store.load()[0]!.messages.length, 1);
  assert.equal(reopened.store.load()[0]!.runs.length, 2);
});
